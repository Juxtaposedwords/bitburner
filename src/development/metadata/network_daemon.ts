import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import { HOME, NETWORK_PATH, PORT_OPENERS, root, scanWithPaths, snapshotNetwork } from "development/libraries/network";
import { rankTargets } from "development/metadata/target_selector";

/**
 * The network, live, every TICK_INTERVAL_MS: roots every server the owned
 * port openers allow, writes the network snapshot (NETWORK_PATH: paths,
 * root, backdoors, organizations) and re-ranks hacking targets
 * (target_selector.ts's rankTargets).
 *
 * Replaces crawl_servers.js, rooter.js and the supervisor's dispatch of
 * them on hacking-level or opener changes: those ran only on triggers and
 * fed the supervisor's cached registry, which went stale across installs
 * (servers never re-rooted, the richest targets missing from the ranking).
 * Doing all three every tick from the live game has nothing to go stale.
 */
const TICK_INTERVAL_MS = 10_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Network", LOG_LEVEL.INFO);
  await log.info("=== Network daemon online ===");

  while (true) {
    const openers = PORT_OPENERS.filter(({ program }) => ns.fileExists(program, HOME)).length;
    for (const { host } of scanWithPaths(ns)) {
      if (host === HOME || ns.hasRootAccess(host) || ns.getServerNumPortsRequired(host) > openers) continue;
      if (root(ns, host)) await log.info(`[Network] Rooted ${host}.`);
    }
    ns.write(NETWORK_PATH, JSON.stringify(snapshotNetwork(ns)), "w");
    await rankTargets(ns, log);
    await ns.asleep(TICK_INTERVAL_MS);
  }
}
