import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["purchaseAugmentation"]>[0];

/** AugBuyService: buying an augmentation, and buying rep with a donation. */
export function createAugBuyHandlers(ns: NS): fs_pb.AugBuyServiceHandlers {
  return {
    Purchase: (req) => ({ ok: ns.singularity.purchaseAugmentation(req.faction as FactionNameType, req.augmentation ?? ""), detail: "" }),
    Donate: (req) => ({ ok: ns.singularity.donateToFaction(req.faction as FactionNameType, req.amount ?? 0), detail: "" }),
  };
}
