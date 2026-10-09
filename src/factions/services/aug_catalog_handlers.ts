import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["getAugmentationsFromFaction"]>[0];

/** AugCatalogService: what `factions` sell, and every listed augmentation's price and rep requirement. */
export function createAugCatalogHandlers(ns: NS): fs_pb.AugCatalogServiceHandlers {
  return {
    Snapshot: (req) => {
      const offers = (req.factions ?? []).map((faction) => ({
        faction,
        augmentations: ns.singularity.getAugmentationsFromFaction(faction as FactionNameType),
      }));
      const names = new Set([...offers.flatMap((o) => o.augmentations), ...(req.extraNames ?? [])]);
      return {
        offers,
        prices: [...names].map((name) => ({ name, price: ns.singularity.getAugmentationPrice(name), repReq: ns.singularity.getAugmentationRepReq(name) })),
      };
    },
  };
}
