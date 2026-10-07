import { NS } from "@ns";
import * as rpc from "system/rpc/rpc";
import { FactionWorkServicePort, RegisterFactionWorkService } from "factions/rpc/faction_services";
import { createWorkHandlers } from "factions/services/work_handlers";

/**
 * Serves FactionWorkService (faction_services.proto) on its port: invites, the work slot, jobs, travel and the gym,
 * for the faction daemon. Runs on any server - ports are global - so it
 * can start on a small hacked server early in a BitNode (docs/faction_split.md).
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const server = rpc.NewServer(ns, FactionWorkServicePort);
  RegisterFactionWorkService(server, createWorkHandlers(ns));
  await server.Serve();
}
