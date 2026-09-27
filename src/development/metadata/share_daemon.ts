import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import { readApproach } from "development/libraries/approach";
import { Approach } from "development/metadata/scheduler";
import { planShareKills, planShareLaunches, shareBonus, shareThreadTarget } from "development/metadata/share_decisions";
import * as server_metadata_pb from "development/metadata/server_metadata";

/**
 * Keeps a fixed slice of the worker fleet's RAM running share_worker.js
 * (ns.share()), which speeds up reputation from faction work - the way to
 * reach augmentations at factions that can't take donations yet (e.g.
 * BitRunners' Neural Accelerator). The bonus is logarithmic in thread count
 * (see share_decisions.ts) and every GB here is taken from HWGW batches, so
 * `fleetFraction` should track what batches are worth. The 0.5 default is
 * for BN9, where script hacking gives 5% of normal experience and almost no
 * money; in a BitNode where hacking pays, something like 0.1 fits better.
 *
 * Same host pool as scheduler_daemon.ts (rooted, never home, never Hacknet
 * servers, which run for hashes). The scheduler already works with live
 * free RAM, so it simply batches with whatever this leaves; nothing needs
 * coordinating beyond that.
 */
export type ShareConfig = { enabled: boolean; fleetFraction: number };

export const DEFAULT_CONFIG: ShareConfig = { enabled: true, fleetFraction: 0.5 };
export const CONFIG_PATH = "/etc/share.txt";

const SHARE_WORKER = "development/metadata/share_worker.js";
const HOME = "home";
// ns.share() cycles are 10s; checking every 30s is plenty to top up after
// the scheduler's prep phase grabs free RAM, or after a config change.
const TICK_INTERVAL_MS = 30_000;

async function listWorkerHosts(ns: NS): Promise<string[]> {
  const res = await server_metadata_pb.NewSupervisorServiceClient(ns).ListServers({});
  if (res.status !== Codes.OK) return [];
  return (res.data?.servers ?? [])
    .filter(
      (s) => s.rootStatus === server_metadata_pb.RootStatus.ROOTED && s.hostname !== HOME && s.kind !== server_metadata_pb.ServerKind.HACKNET
    )
    .map((s) => s.hostname as string);
}

function runningShares(ns: NS, hosts: string[]): { pid: number; threads: number }[] {
  return hosts.flatMap((host) =>
    ns
      .ps(host)
      .filter((p) => p.filename.replace(/^\//, "") === SHARE_WORKER)
      .map((p) => ({ pid: p.pid, threads: p.threads }))
  );
}

async function tick(ns: NS, log: Logger, config: ShareConfig): Promise<void> {
  const ramPerThread = ns.getScriptRam(SHARE_WORKER);
  // getScriptRam returns 0 for a missing file (same guard as
  // scheduler_daemon.ts) - dividing by it would ask for infinite threads.
  if (!(ramPerThread > 0)) {
    await log.warn(`[Share] ${SHARE_WORKER} not found on home yet; waiting for it to sync.`);
    return;
  }

  const hosts = await listWorkerHosts(ns);
  const totalRam = hosts.reduce((sum, host) => sum + ns.getServerMaxRam(host), 0);
  // Share only boosts faction/company rep; during GROW_STATS the player is
  // studying, and during GANG committing crimes, so the RAM goes back to
  // batches.
  const approach = readApproach(ns);
  const growingStats = approach === Approach.GROW_STATS || approach === Approach.GANG;
  const target = config.enabled && !growingStats ? shareThreadTarget(totalRam, config.fleetFraction, ramPerThread) : 0;
  const running = runningShares(ns, hosts);
  const runningThreads = running.reduce((sum, p) => sum + p.threads, 0);

  if (runningThreads > target) {
    const kills = planShareKills(running, target);
    for (const pid of kills) ns.kill(pid);
    await log.info(`[Share] Stopped ${kills.length} share process(es) to get down to ${target} thread(s).`);
  } else if (runningThreads < target) {
    const capacities = hosts.map((host) => ({ host, freeRam: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }));
    let launched = 0;
    for (const { host, threads } of planShareLaunches(capacities, target - runningThreads, ramPerThread)) {
      if (!ns.fileExists(SHARE_WORKER, host)) ns.scp(SHARE_WORKER, host, HOME);
      if (ns.exec(SHARE_WORKER, host, threads) !== 0) launched += threads;
    }
    if (launched > 0) await log.info(`[Share] Launched ${launched} share thread(s).`);
  }

  await log.debug(
    `[Share] tick: growStats=${growingStats} fleet=${(totalRam / 1024).toFixed(1)}TB fraction=${config.fleetFraction} target=${target} running=${runningThreads} ` +
      `expectedBonus=x${shareBonus(target).toFixed(3)} actualSharePower=x${ns.getSharePower().toFixed(3)}`
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Share", LOG_LEVEL.DEBUG);
  await log.info("=== Share manager online ===");

  while (true) {
    await tick(ns, log, loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG));
    await ns.asleep(TICK_INTERVAL_MS);
  }
}
