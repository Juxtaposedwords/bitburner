import { NS } from "@ns";
import * as pb from "factions/rpc/aug_buy";

type FactionNameType = Parameters<NS["singularity"]["purchaseAugmentation"]>[0];

/** AugBuyService: buying an augmentation, and buying rep with a donation. */
export function createAugBuyHandlers(ns: NS): pb.AugBuyServiceHandlers {
  return {
    Purchase: (req) => ({ ok: ns.singularity.purchaseAugmentation(req.faction as FactionNameType, req.augmentation ?? "") }),
    Donate: (req) => ({ ok: ns.singularity.donateToFaction(req.faction as FactionNameType, req.amount ?? 0) }),
  };
}
