import { NS } from "@ns";

/** One-shot diagnostic: dumps ns.cloud's current limits/state directly, independent of purchased_server_daemon.ts's own reading of them. */
export async function main(ns: NS): Promise<void> {
  const owned = ns.cloud.getServerNames();

  ns.tprint(`[CheckCloud] getServerLimit() = ${ns.cloud.getServerLimit()}`);
  ns.tprint(`[CheckCloud] getRamLimit() = ${ns.cloud.getRamLimit()}`);
  ns.tprint(`[CheckCloud] getServerNames() = [${owned.join(", ")}] (${owned.length} owned)`);
  ns.tprint(`[CheckCloud] getServerCost(8) = ${ns.cloud.getServerCost(8)}`);
}
