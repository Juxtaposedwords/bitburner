import { NS } from "@ns";
import * as pb from "factions/rpc/standing";

type FactionNameType = Parameters<NS["singularity"]["getFactionRep"]>[0];
type CompanyNameType = Parameters<NS["singularity"]["getCompanyRep"]>[0];

/** StandingService: owned augmentations, faction rep and favor, company rep. */
export function createStandingHandlers(ns: NS): pb.StandingServiceHandlers {
  return {
    GetStanding: (req) => ({
      standings: (req.factions ?? []).map((faction) => ({
        faction,
        rep: ns.singularity.getFactionRep(faction as FactionNameType),
        favor: ns.singularity.getFactionFavor(faction as FactionNameType),
      })),
      ownedWithQueued: ns.singularity.getOwnedAugmentations(true),
      installed: ns.singularity.getOwnedAugmentations(false),
      favorToDonate: ns.getFavorToDonate(),
      companyStandings: (req.companies ?? []).map((company) => ({ company, rep: ns.singularity.getCompanyRep(company as CompanyNameType) })),
    }),
  };
}
