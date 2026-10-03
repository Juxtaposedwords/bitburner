import { NS } from "@ns";
import { killPrepWorkers } from "development/libraries/network";

/**
 * Stops prep workers (weaken/grow) aimed at a target, on every host:
 *
 *   run tools/kill_workers.js <target>
 */
export async function main(ns: NS): Promise<void> {
  const target = String(ns.args[0] ?? "");
  if (!target) {
    ns.tprint("usage: run tools/kill_workers.js <target>");
    return;
  }
  const killed = killPrepWorkers(ns, target, ["development/metadata/weaken_worker.js", "development/metadata/grow_worker.js"]);
  ns.tprint(`[KillWorkers] Stopped ${killed} prep worker(s) aimed at ${target}.`);
}
