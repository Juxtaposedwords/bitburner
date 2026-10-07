import { NS } from "@ns";
import * as rpc from "system/rpc/rpc";
import { FactionInfoServicePort, RegisterFactionInfoService } from "factions/rpc/faction_services";
import { createInfoHandlers } from "factions/services/info_handlers";

/**
 * Serves FactionInfoService (faction_services.proto) on its port: augmentation catalog, standing and favor,
 * for the faction daemon. Runs on any server - ports are global - so it
 * can start on a small hacked server early in a BitNode (docs/faction_split.md).
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const server = rpc.NewServer(ns, FactionInfoServicePort);
  RegisterFactionInfoService(server, createInfoHandlers(ns));
  await server.Serve();
}
