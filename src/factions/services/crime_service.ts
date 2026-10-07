import { NS } from "@ns";
import * as rpc from "system/rpc/rpc";
import { CrimeServicePort, RegisterCrimeService } from "factions/rpc/faction_services";
import { createCrimeHandlers } from "factions/services/crime_handlers";

/**
 * Serves CrimeService (faction_services.proto) on its port: crime stats and committing crimes,
 * for the faction daemon. Runs on any server - ports are global - so it
 * can start on a small hacked server early in a BitNode (docs/faction_split.md).
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const server = rpc.NewServer(ns, CrimeServicePort);
  RegisterCrimeService(server, createCrimeHandlers(ns));
  await server.Serve();
}
