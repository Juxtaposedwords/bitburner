/**
 * Pure decision logic for stock_daemon.ts - no `ns` dependency, mirrors
 * hacknet_decisions.ts's shape. Long-only v1 (see StockPosition's
 * position: "L" tag) - the daemon buys when a stock's forecast clears
 * buyThreshold and sells to exit once it drops back to sellThreshold,
 * re-deriving everything fresh every tick rather than tracking a plan
 * across calls, the same "no lookahead" house style used everywhere else
 * in this codebase.
 */
export type StockPosition = { sym: string; shares: number; costBasis: number; position: "L" };

/**
 * Evaluates EVERY held position each tick and returns every one whose
 * forecast has dropped to sellThreshold or below - unbounded, not capped
 * to one per tick. Mirrors gang_daemon.ts's assignTasks/assignTraining
 * acting on the whole member roster every tick, not one member at a
 * time: exiting a no-longer-favorable position is risk reduction, not a
 * new commitment, so there's no reason to throttle it the way new spend
 * is throttled below.
 *
 * A symbol missing from `forecasts` (e.g. a transient gap) is always
 * held, never sold - "no information" must never be treated as a reason
 * to exit. This can't be done by just defaulting the missing value to
 * 0.5 (neutral) and running it through the same `<= sellThreshold`
 * comparison: 0.5 IS this daemon's own default sellThreshold, so that
 * fallback would still trigger a sell right at the boundary - caught by
 * this file's own test suite. Missing data is therefore its own
 * explicit branch, not a defaulted value fed into the normal check.
 */
export function decideStocksToSell(
  positions: StockPosition[],
  forecasts: Map<string, number>,
  sellThreshold: number
): { sym: string; shares: number }[] {
  return positions
    .filter((p) => forecasts.has(p.sym) && (forecasts.get(p.sym) as number) <= sellThreshold)
    .map((p) => ({ sym: p.sym, shares: p.shares }));
}

export type BuyCandidate = { sym: string; forecast: number; existingCostBasis: number };

/**
 * Full picture of one tick's buy evaluation, not just the decisions made -
 * same diagnosability contract as hacknet_decisions.ts's
 * InvestmentEvaluation. `bestCandidate` is the single highest-forecast
 * candidate found, whether or not anything was actually bought.
 */
export type BuyEvaluation = {
  decisions: { sym: string; shares: number }[];
  budget: number;
  candidateCount: number;
  bestCandidate?: { sym: string; forecast: number };
};

export type BuyLimits = {
  reserveMoney: number;
  maxSpendFraction: number;
  // Per-symbol cap, as a fraction of net worth (cash + invested cost basis).
  maxPositionFraction: number;
  // Total stock exposure cap, as a fraction of net worth.
  maxInvestedFraction: number;
};

/**
 * Splits this tick's budget across candidates in forecast order, each
 * bounded by its own per-symbol room - one allocation decision per tick,
 * the same shape as hwgw.ts's allocateAcrossHosts rather than a single
 * winner.
 *
 * Both caps are measured against net worth (cash + invested cost basis),
 * not cash alone. The first version capped each position at a fraction of
 * *cash* and bought only one symbol per tick: with gang income refilling
 * cash every tick, the top stock's room grew every tick too, so it won
 * every single tick and nothing else was ever bought - caught live, all
 * buys went to MGCP while four other qualifying stocks sat untouched and
 * most of each tick's budget went unspent.
 *
 * maxInvestedFraction keeps a share of net worth in cash - stocks are
 * liquid, but faction augmentation purchases and Daedalus's money
 * requirement only count cash on hand.
 *
 * `affordable` is an injected closure (mirrors purchased_server_decisions.ts's
 * cost-closure pattern) so this module stays ns-free - price isn't linear
 * in share count, so the real closure (stock_daemon.ts) binary-searches
 * ns.stock.getPurchaseCost; a test can pass a linear stand-in.
 */
export function decideStockToBuy(
  candidates: BuyCandidate[],
  money: number,
  investedCostBasis: number,
  limits: BuyLimits,
  affordable: (sym: string, budgetForSymbol: number) => { shares: number; cost: number }
): BuyEvaluation {
  const netWorth = money + investedCostBasis;
  const spendBudget = Math.max(0, Math.min(money - limits.reserveMoney, money * limits.maxSpendFraction));
  const exposureRoom = Math.max(0, limits.maxInvestedFraction * netWorth - investedCostBasis);
  const budget = Math.min(spendBudget, exposureRoom);

  if (candidates.length === 0) return { decisions: [], budget, candidateCount: 0 };

  const ranked = [...candidates].sort((a, b) => b.forecast - a.forecast);
  const decisions: { sym: string; shares: number }[] = [];
  let remaining = budget;

  for (const candidate of ranked) {
    if (remaining <= 0) break;
    const positionRoom = Math.max(0, limits.maxPositionFraction * netWorth - candidate.existingCostBasis);
    const symbolBudget = Math.min(remaining, positionRoom);
    if (symbolBudget <= 0) continue;

    const { shares, cost } = affordable(candidate.sym, symbolBudget);
    if (shares <= 0) continue;
    decisions.push({ sym: candidate.sym, shares });
    remaining -= cost;
  }

  return {
    decisions,
    budget,
    candidateCount: candidates.length,
    bestCandidate: { sym: ranked[0].sym, forecast: ranked[0].forecast },
  };
}
