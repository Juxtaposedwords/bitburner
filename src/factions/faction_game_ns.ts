import { NS } from "@ns";
import { AugmentationInfo, pendingAugmentations } from "factions/faction_decisions";

type FactionNameType = Parameters<NS["singularity"]["getFactionRep"]>[0];

/**
 * Faction and augmentation reads straight from ns, for tools run by hand
 * (augmentation_report.js, install_now.js). The faction daemon itself gets
 * these through FactionInfoService instead, so it doesn't carry their RAM.
 */

/** Every augmentation offered by any of `joinedFactions`, queried live. */
export function gatherCatalog(ns: NS, joinedFactions: string[]): AugmentationInfo[] {
  const catalog: AugmentationInfo[] = [];
  for (const faction of joinedFactions) {
    for (const name of ns.singularity.getAugmentationsFromFaction(faction as FactionNameType)) {
      catalog.push({
        name,
        faction,
        price: ns.singularity.getAugmentationPrice(name),
        repReq: ns.singularity.getAugmentationRepReq(name),
        prereqs: ns.singularity.getAugmentationPrereq(name),
        stats: ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>,
      });
    }
  }
  return catalog;
}

export function gatherReps(ns: NS, joinedFactions: string[]): Record<string, number> {
  const reps: Record<string, number> = {};
  for (const faction of joinedFactions) reps[faction] = ns.singularity.getFactionRep(faction as FactionNameType);
  return reps;
}

/** Augmentations bought but not installed yet. */
export function getPendingAugmentations(ns: NS): string[] {
  return pendingAugmentations(ns.singularity.getOwnedAugmentations(true), ns.singularity.getOwnedAugmentations(false));
}
