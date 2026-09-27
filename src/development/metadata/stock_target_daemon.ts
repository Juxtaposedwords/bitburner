import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import * as server_metadata_pb from "development/metadata/server_metadata";
import { WeightedServer, WeightsFile } from "development/metadata/target_selector";

/**
 * Small always-on daemon that ranks stock-linked servers we currently
 * hold long, for scheduler_daemon.ts's Approach.STOCK_TARGETING mode to
 * read. Kept separate from scheduler_daemon.ts itself (already the
 * single most RAM-expensive script in this codebase, ~8.6 GB) rather
 * than adding ns.stock.* references directly into it - ns.stock has
 * normal fixed RAM costs (no isolation *requirement* the way
 * ns.singularity has), but growing an already-maxed-out script for a
 * niche mode is still worth avoiding. Same RAM-isolation reasoning
 * target_selector.ts already exists for its own money/security ranking.
 *
 * Ticks every 5s (not change-triggered like target_selector.ts, which
 * only recomputes on a hacking-level change or a rooter completion) -
 * "which stock we hold long" changes on the timescale of stock_daemon.ts's
 * own 5s tick, not on hacking-level changes, so a change-triggered design
 * would go stale relative to portfolio changes almost immediately.
 *
 * Reuses target_selector.ts's WeightsFile/WeightedServer types verbatim -
 * no duplicate parsing code, scheduler_daemon.ts's resolveTarget reads
 * this file with the exact same readWeightsFile helper it already uses
 * for the normal money/security ranking. `hackingLevel` in the written
 * file is always 0 and meaningless here (that field only means something
 * to target_selector.ts's own staleness check) - readWeightsFile/
 * resolveTarget never look at it, only `weights[0]?.hostname`.
 *
 * Long-only, matching stock_daemon.ts's own v1 scope - short positions
 * are never considered.
 */
export type StockTargetConfig = { enabled: boolean; weightsPath: string };

export const DEFAULT_CONFIG: StockTargetConfig = {
  enabled: true,
  weightsPath: "/var/stock_target_selector/weights.txt",
};

export const CONFIG_PATH = "/etc/stock_target_selector.txt";
const TICK_INTERVAL_MS = 5000;

export function loadConfig(ns: NS): StockTargetConfig {
  return loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
}

/**
 * Ranks every known server whose organization matches a stock we
 * currently hold long, by cost basis (shares * avgLongPrice, passed in
 * via `longPositionCostBasis`) descending - defend the biggest position
 * first. Simple and not ROI-optimal (doesn't weigh current forecast,
 * volatility, or proximity to a sellThreshold) - same "simplest
 * reasonable v1" tradeoff target_selector.ts's own maxMoney/
 * minSecurityLevel placeholder heuristic already accepts.
 */
export function computeStockTargetWeights(
  servers: server_metadata_pb.Metadata[],
  longPositionCostBasis: Map<string, number>
): WeightedServer[] {
  return servers
    .filter((server) => !!server.hostname && !!server.organization && longPositionCostBasis.has(server.organization))
    .map((server) => ({ hostname: server.hostname as string, weight: longPositionCostBasis.get(server.organization as string) as number }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * organization -> cost basis, for every stock currently held long - queried
 * live, no persisted portfolio (mirrors stock_daemon.ts's own
 * gatherPositions). Empty without TIX API access: every other ns.stock call
 * throws then, and a new BitNode starts without it (the first BN10 run
 * crashed here) - with nothing held there's nothing to defend anyway.
 */
function gatherLongPositionCostBasisByOrganization(ns: NS): Map<string, number> {
  const costBasisByOrg = new Map<string, number>();
  if (!ns.stock.hasTixApiAccess()) return costBasisByOrg;
  for (const sym of ns.stock.getSymbols()) {
    const [sharesLong, avgLongPrice] = ns.stock.getPosition(sym);
    if (sharesLong > 0) costBasisByOrg.set(ns.stock.getOrganization(sym), sharesLong * avgLongPrice);
  }
  return costBasisByOrg;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so a quiet tick (nothing held long, or nothing stock-linked
  // known) is distinguishable from a stuck process, same convention as
  // every other daemon in this codebase.
  const log = createLogger(ns, "StockTarget", LOG_LEVEL.DEBUG);

  await log.info("=== Stock target selector online ===");

  while (true) {
    const config = loadConfig(ns);

    if (config.enabled) {
      const longPositionCostBasis = gatherLongPositionCostBasisByOrganization(ns);

      // eligibleOnly (rooted + has money + within hacking level), same as
      // target_selector.ts - scheduler_daemon.ts can only batch a target
      // hackAnalyzeThreads accepts. Without this, a held-long stock whose
      // server is above our hacking level (megacorp at level 858, say)
      // would pin the whole fleet onto a target every batch tick skips.
      const res = await server_metadata_pb.NewSupervisorServiceClient(ns).ListServers({ eligibleOnly: true });
      const weights = res.status === Codes.OK ? computeStockTargetWeights(res.data?.servers ?? [], longPositionCostBasis) : [];

      const file: WeightsFile = { hackingLevel: 0, computedAt: Date.now(), weights };
      ns.write(config.weightsPath, JSON.stringify(file, null, 2), "w");

      await log.debug(
        `[StockTarget] tick: longPositions=${longPositionCostBasis.size} stockLinkedTargets=${weights.length} top=${weights[0]?.hostname ?? "none"}`
      );
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
