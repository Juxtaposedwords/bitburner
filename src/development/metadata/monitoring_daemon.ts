import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import { appendPoint, DEFAULT_CAPACITY, DEFAULT_STEP_SECONDS, readSeries, writeSeries } from "development/libraries/timeseries";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

/**
 * Samples the economy once a minute into fixed-size time series under
 * /var/monitoring/ (see development/libraries/timeseries.ts), read back by
 * tools/monitor.ts. The only writer of every file there, so no two scripts
 * ever write the same file.
 *
 * Counters come straight from ns.getMoneySources().sinceStart - the game's
 * own cumulative per-category totals - so no purchase call site anywhere
 * needs instrumenting. sinceStart rather than sinceInstall so installing
 * augmentations doesn't reset them. Every nonzero category is recorded as
 * counter/<key> with nothing hardcoded; tools/monitor.ts decides income vs.
 * spend from the sign of the change.
 *
 * Deliberately left out of wipe_data.ts's WIPE_PREFIXES, so history
 * survives test_restart.js - a restart shows up as a gap of nulls.
 */
const TICK_INTERVAL_MS = DEFAULT_STEP_SECONDS * 1000;

function record(ns: NS, id: string, t: number, value: number): void {
  writeSeries(ns, id, appendPoint(readSeries(ns, id), t, value, DEFAULT_STEP_SECONDS, DEFAULT_CAPACITY));
}

/** Market value of long positions at the current bid. undefined without TIX API access, since the other ns.stock calls need it. */
function stockValue(ns: NS): number | undefined {
  if (!ns.stock.hasTixApiAccess()) return undefined;
  let total = 0;
  for (const sym of ns.stock.getSymbols()) {
    const [sharesLong] = ns.stock.getPosition(sym);
    if (sharesLong > 0) total += sharesLong * ns.stock.getBidPrice(sym);
  }
  return total;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Monitoring", LOG_LEVEL.DEBUG);
  await log.info("=== Monitoring sampler online ===");

  while (true) {
    const t = Math.floor(Date.now() / 1000);

    let counters = 0;
    for (const [key, value] of Object.entries(ns.getMoneySources().sinceStart)) {
      // "total" is the net of every category - tools/monitor.ts shows net
      // change via the cash gauge instead.
      if (key === "total" || value === 0) continue;
      record(ns, `counter/${key}`, t, value);
      counters++;
    }

    const playerRes = await player_metadata_pb
      .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
      .GetPlayerMetadata({});
    const cash = playerRes.data?.player?.money ?? 0;
    record(ns, "gauge/cash", t, cash);
    record(ns, "gauge/hacking_level", t, playerRes.data?.player?.hackingLevel ?? 0);

    const stock = stockValue(ns);
    if (stock !== undefined) record(ns, "gauge/stock_value", t, stock);
    record(ns, "gauge/net_worth", t, cash + (stock ?? 0));

    await log.debug(`[Monitoring] sampled ${counters} counter(s), cash=$${cash.toFixed(0)} stock=$${(stock ?? 0).toFixed(0)}`);

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
