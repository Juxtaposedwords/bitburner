import { NS } from "@ns";
import * as pb from "factions/rpc/aug_catalog";

type FactionNameType = Parameters<NS["singularity"]["getAugmentationsFromFaction"]>[0];

/** AugCatalogService: what `factions` sell, and every listed augmentation's price and rep requirement. */
export function createAugCatalogHandlers(ns: NS): pb.AugCatalogServiceHandlers {
  return {
    GetCatalog: (req) => {
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
