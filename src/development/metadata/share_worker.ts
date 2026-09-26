import { NS } from "@ns";

/**
 * Shares this host's RAM with factions, forever. Each ns.share() call lasts
 * 10 seconds and boosts faction-work rep gain while it runs; the boost
 * scales with the thread count this script was launched with. Kept minimal
 * (only ns.share referenced) for the same per-script RAM reason as
 * hack_worker.ts. Started and stopped by share_daemon.ts.
 */
export async function main(ns: NS): Promise<void> {
  while (true) {
    await ns.share();
  }
}
