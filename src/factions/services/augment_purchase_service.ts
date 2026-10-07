import { NS } from "@ns";
import * as rpc from "system/rpc/rpc";
import { AugmentPurchaseServicePort, RegisterAugmentPurchaseService } from "factions/rpc/faction_services";
import { createPurchaseHandlers } from "factions/services/purchase_handlers";

/**
 * Serves AugmentPurchaseService (faction_services.proto) on its port: buying, donating and installing,
 * for the faction daemon. Runs on any server - ports are global - so it
 * can start on a small hacked server early in a BitNode (docs/faction_split.md).
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const server = rpc.NewServer(ns, AugmentPurchaseServicePort);
  RegisterAugmentPurchaseService(server, createPurchaseHandlers(ns));
  await server.Serve();
}
