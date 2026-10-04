import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "system/logs";
import { backdoorTargets, HOME, readNetwork } from "hacking/network";

/**
 * Backdoors every server worth it (network.ts's backdoorTargets: NPC,
 * rooted, within hacking level, not done, never w0r1d_d43m0n), from
 * network_daemon.ts's live snapshot. Kept apart from that daemon because
 * ns.singularity's RAM cost belongs only here.
 */
const TICK_INTERVAL_MS = 5000;

/** Walks `path` one hop at a time (connect only reaches neighbors), backdoors, and returns home. */
async function backdoor(ns: NS, path: string[]): Promise<boolean> {
  try {
    for (const hop of path) if (!ns.singularity.connect(hop)) return false;
    await ns.singularity.installBackdoor();
    return true;
  } catch {
    return false;
  } finally {
    ns.singularity.connect(HOME);
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Backdoor", LOG_LEVEL.INFO);
  await log.info("=== Backdoor manager online ===");

  while (true) {
    const network = readNetwork(ns);
    for (const server of network ? backdoorTargets(network) : []) {
      // The snapshot can be up to a tick old - check root live.
      if (!ns.hasRootAccess(server.host)) continue;
      await log.info(`[Backdoor] Backdooring ${server.host}...`);
      if (await backdoor(ns, server.path)) await log.info(`[Backdoor] Backdoored ${server.host}.`);
      else await log.warn(`[Backdoor] Couldn't reach or backdoor ${server.host}; leaving it for the next pass.`);
    }
    await ns.asleep(TICK_INTERVAL_MS);
  }
}
