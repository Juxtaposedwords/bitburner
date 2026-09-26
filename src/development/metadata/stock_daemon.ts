import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { isInstallPendingActive, readInstallPending } from "development/libraries/install_handshake";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { BuyCandidate, decideStocksToSell, decideStockToBuy, StockPosition } from "development/metadata/stock_decisions";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

/**
 * ns.stock has normal fixed RAM costs (no Source-File multiplier, unlike
 * ns.singularity - confirmed in NetscriptDefinitions.d.ts), so this
 * doesn't need the same single-file isolation invariant program_shopper.ts/
 * backdoor_daemon.ts/faction_daemon.ts have. No BitNode/Source-File gate
 * exists for the stock market itself either (ResetInfo.bitNodeOptions has
 * no "stock market disabled" flag, only disable4SData, which is handled
 * at runtime below, not at boot time) - so unlike singularityAvailable/
 * gangAvailable, this daemon needs no PlayerMetadata capability field and
 * boot.ts launches it unconditionally.
 *
 * Trading defaults ON once API access exists (config.enabled is the only
 * switch) - a wrong forecast call losing money is the same category of
 * ROI risk this codebase already accepts for Hacknet/purchased-server/
 * gang-equipment spending (all default on), not the same category as
 * installAugmentations/committing crimes (which default off).
 *
 * Long-only v1 - see stock_decisions.ts's module doc.
 */
export type StockConfig = {
  enabled: boolean;
  reserveMoney: number;
  maxSpendFraction: number;
  // Per-symbol cap as a fraction of net worth (cash + invested cost basis)
  // - see decideStockToBuy's doc for why net worth, not cash. Simple and
  // cheap, not Kelly/correlation-aware - same "simplest reasonable v1"
  // tradeoff decideEquipmentPurchase accepts.
  maxPositionFraction: number;
  // Total stock exposure cap as a fraction of net worth - keeps the rest
  // in cash for faction augmentation purchases and Daedalus's
  // cash-on-hand money requirement, neither of which counts stock.
  maxInvestedFraction: number;
  // Comfortably past the 0.5 coin-flip line ns.stock.getForecast returns.
  buyThreshold: number;
  // Exit the instant true edge disappears - deliberately not symmetric
  // with buyThreshold. The gap between the two (a hysteresis band) damps
  // commission-costly buy/sell thrashing right at the boundary: a stock
  // oscillating between sellThreshold and buyThreshold is never newly
  // bought, but if already held, isn't sold either until it actually
  // drops to sellThreshold.
  sellThreshold: number;
  // Binary accept/reject filter on NEW buys only (never forces an exit) -
  // not used for position sizing (no inverse-volatility scaling), a
  // deliberate v1 scope cut.
  maxVolatility: number;
};

export const DEFAULT_CONFIG: StockConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  maxPositionFraction: 0.25,
  maxInvestedFraction: 0.5,
  buyThreshold: 0.6,
  sellThreshold: 0.5,
  maxVolatility: 0.05,
};

export const CONFIG_PATH = "/etc/stock.txt";
const TICK_INTERVAL_MS = 5000;

/**
 * Buys TIX API access (required for buyStock/sellStock via scripts) and
 * 4S Market Data TIX API access (required for getForecast/getVolatility)
 * whenever affordable - check-before-buy so this only logs on the tick it
 * actually transitions, same discipline scheduler_daemon.ts's
 * manageTerritoryEngagement already uses.
 *
 * purchase4SMarketDataTixApi() is gated on hasTixApiAccess() being true
 * FIRST, not just attempted whenever has4SDataTixApi() is false - unlike
 * every other purchase call in this codebase (which return falsy on an
 * unmet precondition, e.g. unaffordable), this one throws a runtime
 * error instead if TIX API access isn't already owned ("You don't have
 * TIX API Access!"), confirmed live: purchaseTixApi() failing this same
 * tick (still saving up) used to fall through into this call anyway and
 * crash the whole daemon. Checked fresh (not the pre-purchase-attempt
 * value) so it also succeeds within the same tick TIX API access is
 * first bought.
 *
 * Deliberately never buys a WSE account (purchaseWseAccount) or the plain
 * 4S Market Data (purchase4SMarketData) - both are UI-only per their own
 * doc comments ("you can buy TIX API access without a WSE account"; the
 * plain 4S variant "only unlocks access to 4S Market Data in the Stock
 * Market UI"). A script never touches the UI, so buying either would be
 * pure wasted money with zero functional benefit to this daemon.
 */
async function ensureAccess(ns: NS, log: Logger): Promise<boolean> {
  if (!ns.stock.hasTixApiAccess() && ns.stock.purchaseTixApi()) {
    await log.info("[Stock] Purchased TIX API access.");
  }
  if (ns.stock.hasTixApiAccess() && !ns.stock.has4SDataTixApi() && ns.stock.purchase4SMarketDataTixApi()) {
    await log.info("[Stock] Purchased 4S Market Data (TIX API).");
  }
  return ns.stock.has4SDataTixApi();
}

/** Every currently-held long position, queried live - no persisted portfolio. */
function gatherPositions(ns: NS): StockPosition[] {
  const positions: StockPosition[] = [];
  for (const sym of ns.stock.getSymbols()) {
    const [sharesLong, avgLongPrice] = ns.stock.getPosition(sym);
    if (sharesLong > 0) positions.push({ sym, shares: sharesLong, costBasis: sharesLong * avgLongPrice, position: "L" });
  }
  return positions;
}

/**
 * Largest share count affordable within `budget`, via binary search over
 * ns.stock.getPurchaseCost - price isn't linear in share count (spread +
 * large-transaction slippage, per its own doc comment), so a straight
 * division by price would over/undershoot. getPurchaseCost already folds
 * in commission, so no separate commission math is needed here.
 */
function computeAffordableShares(ns: NS, sym: string, budget: number, maxShares: number): number {
  if (budget <= 0 || maxShares <= 0) return 0;

  let lo = 0;
  let hi = maxShares;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ns.stock.getPurchaseCost(sym, mid, "L") <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function executeSells(ns: NS, log: Logger, sells: { sym: string; shares: number }[]): Promise<void> {
  for (const sell of sells) {
    const price = ns.stock.sellStock(sell.sym, sell.shares);
    if (price > 0) await log.info(`[Stock] Sold ${sell.shares} shares of ${sell.sym} @ $${price.toFixed(2)}.`);
  }
}

async function executeBuys(ns: NS, log: Logger, decisions: { sym: string; shares: number }[]): Promise<void> {
  for (const decision of decisions) {
    const price = ns.stock.buyStock(decision.sym, decision.shares);
    if (price > 0) await log.info(`[Stock] Bought ${decision.shares} shares of ${decision.sym} @ $${price.toFixed(2)}.`);
  }
}

async function tick(ns: NS, log: Logger, config: StockConfig): Promise<void> {
  const playerRes = await player_metadata_pb
    .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
    .GetPlayerMetadata({});
  const money = playerRes.data?.player?.money ?? 0;

  const ready = await ensureAccess(ns, log);
  if (!ready) {
    // Idle-and-log, same shape gang_daemon.ts uses for its Formulas.exe
    // gate - covers both "still saving up" and a BitNode with
    // disable4SData set permanently, without ever trading on an
    // unreliable/default forecast value. Logs hasTixApiAccess/money too -
    // without this, "not available" alone can't distinguish "still saving
    // up for the $5B TIX API step" from "have TIX API, saving up for the
    // 4S step" from "something is actually stuck". The 4S TIX API price is
    // $25B * the BitNode's FourSigmaMarketDataApiCost multiplier (4 in
    // BN9, so $100B there) - the flat $25B constant alone is misleading.
    await log.debug(
      `[Stock] Not ready: hasTixApiAccess=${ns.stock.hasTixApiAccess()} has4SDataTixApi=${ns.stock.has4SDataTixApi()} money=$${money.toFixed(0)}; idling.`
    );
    return;
  }

  const positions = gatherPositions(ns);

  // Pre-install wind-down (see development/libraries/install_handshake.ts):
  // an augmentation install deletes every position with no refund, so sell
  // everything - forecast irrelevant - and buy nothing until it's over.
  if (isInstallPendingActive(readInstallPending(ns), Math.floor(Date.now() / 1000))) {
    await executeSells(
      ns,
      log,
      positions.map((p) => ({ sym: p.sym, shares: p.shares }))
    );
    await log.debug(`[Stock] Install pending: liquidated ${positions.length} position(s); not buying until the install is done or cancelled.`);
    return;
  }

  const symbols = ns.stock.getSymbols();
  const forecasts = new Map(symbols.map((sym) => [sym, ns.stock.getForecast(sym)]));

  const sells = decideStocksToSell(positions, forecasts, config.sellThreshold);
  await executeSells(ns, log, sells);

  const candidates: BuyCandidate[] = symbols
    .filter((sym) => (forecasts.get(sym) ?? 0) >= config.buyThreshold && ns.stock.getVolatility(sym) <= config.maxVolatility)
    .map((sym) => ({
      sym,
      forecast: forecasts.get(sym) ?? 0,
      existingCostBasis: positions.find((p) => p.sym === sym)?.costBasis ?? 0,
    }));

  // getMaxShares is the combined ceiling across all positions in that
  // symbol, so subtract what's already held.
  const affordable = (sym: string, budgetForSymbol: number): { shares: number; cost: number } => {
    const held = positions.find((p) => p.sym === sym)?.shares ?? 0;
    const shares = computeAffordableShares(ns, sym, budgetForSymbol, ns.stock.getMaxShares(sym) - held);
    return { shares, cost: shares > 0 ? ns.stock.getPurchaseCost(sym, shares, "L") : 0 };
  };

  const investedCostBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const evaluation = decideStockToBuy(candidates, money, investedCostBasis, config, affordable);

  await log.debug(
    `[Stock] tick: money=$${money.toFixed(0)} invested=$${investedCostBasis.toFixed(0)} positions=${positions.length} sold=${sells.length} ` +
      `budget=$${evaluation.budget.toFixed(0)} candidates=${evaluation.candidateCount} best=${
        evaluation.bestCandidate ? `${evaluation.bestCandidate.sym}@${evaluation.bestCandidate.forecast.toFixed(2)}` : "n/a"
      } -> ${evaluation.decisions.length > 0 ? evaluation.decisions.map((d) => `buy ${d.shares} ${d.sym}`).join(", ") : "none"}`
  );

  await executeBuys(ns, log, evaluation.decisions);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so every tick's evaluation is visible, same as every other
  // spending daemon - a "did nothing" tick otherwise looks identical to a
  // hung process from the logs alone.
  const log = createLogger(ns, "Stock", LOG_LEVEL.DEBUG);

  await log.info("=== Stock market manager online ===");

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      await tick(ns, log, config);
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
