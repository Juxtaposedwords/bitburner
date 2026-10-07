import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["getFactionRep"]>[0];
type CompanyNameType = Parameters<NS["singularity"]["getCompanyRep"]>[0];

/** One augmentation's details, as the game reports them. */
export function describeAugmentation(ns: NS, name: string): fs_pb.Augmentation {
  const stats = ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>;
  return {
    name,
    price: ns.singularity.getAugmentationPrice(name),
    repReq: ns.singularity.getAugmentationRepReq(name),
    prereqs: ns.singularity.getAugmentationPrereq(name),
    stats: Object.entries(stats).map(([key, value]) => ({ key, value })),
  };
}

/**
 * FactionInfoService (faction_services.proto): what factions sell, the
 * player's standing with them, and owned augmentations - read in one call
 * per tick by the faction daemon.
 */
export function createInfoHandlers(ns: NS): fs_pb.FactionInfoServiceHandlers {
  return {
    Snapshot: (req) => {
      const offers = (req.offerFactions ?? []).map((faction) => ({
        faction,
        augmentations: ns.singularity.getAugmentationsFromFaction(faction as FactionNameType),
      }));
      const ownedWithQueued = ns.singularity.getOwnedAugmentations(true);
      const installed = ns.singularity.getOwnedAugmentations(false);
      const installedSet = new Set(installed);
      const names = new Set([...offers.flatMap((o) => o.augmentations), ...ownedWithQueued.filter((n) => !installedSet.has(n))]);
      return {
        offers,
        augmentations: [...names].map((name) => describeAugmentation(ns, name)),
        standings: (req.standingFactions ?? []).map((faction) => ({
          faction,
          rep: ns.singularity.getFactionRep(faction as FactionNameType),
          favor: ns.singularity.getFactionFavor(faction as FactionNameType),
        })),
        ownedWithQueued,
        installed,
        favorToDonate: ns.getFavorToDonate(),
        companyStandings: (req.companies ?? []).map((company) => ({ company, rep: ns.singularity.getCompanyRep(company as CompanyNameType) })),
      };
    },
  };
}
