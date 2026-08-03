import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";

/**
 * The only file in the codebase allowed to reference ns.singularity.* —
 * kept completely isolated from supervisor.ts/scheduler_daemon.ts/
 * everything else so its RAM cost (2-32 GB per function depending on
 * Source-File 4's level, see server_metadata.md) never leaks into another
 * script's footprint. Only launched by boot.ts when
 * PlayerMetadata.singularityAvailable is true.
 */
const PORT_OPENER_PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"] as const;

const POLL_INTERVAL_MS = 30_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "ProgramShopper", LOG_LEVEL.INFO);

  while (true) {
    // Idempotent - returns true if already owned, so this is safe to call every tick.
    ns.singularity.purchaseTor();

    const money = ns.getPlayer().money;
    for (const program of PORT_OPENER_PROGRAMS) {
      // 0 = already owned, -1 = no TOR yet. Either way, nothing to buy.
      const cost = ns.singularity.getDarkwebProgramCost(program);
      if (cost > 0 && cost <= money) {
        if (ns.singularity.purchaseProgram(program)) {
          await log.info(`[ProgramShopper] Purchased ${program} for $${cost.toLocaleString()}.`);
        }
      }
    }

    await ns.asleep(POLL_INTERVAL_MS);
  }
}
