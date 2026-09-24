/**
 * Pure decision logic for faction_daemon.ts - no `ns` dependency, mirrors
 * hacknet_decisions.ts's shape. faction_daemon.ts re-derives every input
 * here fresh from ns.singularity.* each tick (reputation, catalog, owned
 * augmentations) rather than persisting any of it itself, the same
 * approach hacknet_daemon.ts takes with node stats - so each function only
 * ever needs to make ONE decision per tick; the next tick re-gathers
 * fresh state rather than tracking a purchase queue across calls.
 *
 * NeuroFlux Governor is the one augmentation exempt from "already owned"
 * exclusion - it's uncapped and repeatable, unlike every other
 * augmentation (bought once). Its escalating price across repeated
 * purchases (and everyone else's, actually - the game inflates the price
 * of everything unpurchased after each buy) doesn't need modeling here at
 * all: since only one augmentation is bought per tick and the daemon
 * re-queries live prices from ns.singularity every tick, the inflation is
 * already reflected in `catalog` by the time the next decision runs.
 */
export const NEUROFLUX_GOVERNOR = "NeuroFlux Governor";

export type AugmentationInfo = {
  name: string;
  faction: string;
  price: number;
  repReq: number;
  prereqs: string[];
};

export type PurchaseDecision = { kind: "none" } | { kind: "buy"; faction: string; augmentation: string };

/** Invitations minus factions already joined, further narrowed by an optional allowlist (undefined = join everything invited). */
export function decideFactionsToJoin(invitations: string[], alreadyJoined: string[], allowlist?: string[]): string[] {
  const joined = new Set(alreadyJoined);
  return invitations.filter((faction) => !joined.has(faction) && (!allowlist || allowlist.includes(faction)));
}

/**
 * Which joined faction to work for right now: whichever has the smallest
 * positive reputation gap to its next still-wanted augmentation - working
 * there finishes something soonest, rather than spreading effort thin
 * across every faction at once. A faction with nothing left to unlock
 * (every offering owned, or none left needing more rep) isn't returned.
 */
export function decideWorkTarget(
  joinedFactions: string[],
  reps: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[]
): string | undefined {
  const ownedSet = new Set(owned);

  let best: { faction: string; gap: number } | undefined;
  for (const faction of joinedFactions) {
    const currentRep = reps[faction] ?? 0;
    const gaps = catalog
      .filter((aug) => aug.faction === faction && (aug.name === NEUROFLUX_GOVERNOR || !ownedSet.has(aug.name)))
      .map((aug) => aug.repReq - currentRep)
      .filter((gap) => gap > 0);

    if (gaps.length === 0) continue;
    const smallestGap = Math.min(...gaps);
    if (!best || smallestGap < best.gap) best = { faction, gap: smallestGap };
  }

  return best?.faction;
}

/**
 * Cheapest augmentation that's affordable, has its reputation requirement
 * met, and has every prereq already owned - same greedy cheapest-first
 * shape as decideNodeInvestment's non-ROI fallback. `owned` should include
 * augmentations already purchased-but-not-yet-installed this session (see
 * ns.singularity.getOwnedAugmentations(true)) so a prereq bought earlier
 * this run counts immediately, and so we don't try to buy the same
 * (non-repeatable) augmentation twice before an install.
 */
export function decideAugmentationPurchase(
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  reps: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[]
): PurchaseDecision {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));
  const ownedSet = new Set(owned);

  const eligible = catalog.filter((aug) => {
    if (aug.name !== NEUROFLUX_GOVERNOR && ownedSet.has(aug.name)) return false;
    if ((reps[aug.faction] ?? 0) < aug.repReq) return false;
    if (!aug.prereqs.every((prereq) => ownedSet.has(prereq))) return false;
    return aug.price <= budget;
  });

  if (eligible.length === 0) return { kind: "none" };

  const cheapest = eligible.reduce((best, aug) => (aug.price < best.price ? aug : best));
  return { kind: "buy", faction: cheapest.faction, augmentation: cheapest.name };
}

/** True once this tick found nothing left worth buying and something purchased-but-uninstalled is actually waiting to be installed. */
export function decideInstallReady(purchaseDecision: PurchaseDecision, pendingAugmentations: string[]): boolean {
  return purchaseDecision.kind === "none" && pendingAugmentations.length > 0;
}
