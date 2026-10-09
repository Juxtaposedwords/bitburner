/**
 * Pure decision logic for faction_daemon.ts - no `ns` dependency (except a
 * single type-only import for the eligibility engine below, erased at
 * compile time - see that section's own comment), mirrors
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
import type { PlayerRequirement } from "@ns";
import { matchesFocus } from "factions/skill_progress";

export const NEUROFLUX_GOVERNOR = "NeuroFlux Governor";
// Installing it reveals w0r1d_d43m0n - the BitNode's finish line.
export const RED_PILL = "The Red Pill";
export const DAEDALUS = "Daedalus";
// Every install as a JSON line (faction_daemon.ts writes it, tools read it).
export const INSTALL_HISTORY_PATH = "/var/install_history.txt";

/**
 * Written by faction_daemon.ts every tick: every joined faction's current
 * rep, plus which one it's working for. monitoring_daemon.ts turns it into
 * gauge/rep_<faction> series (see repSeriesId) - reading rep directly would
 * put ns.singularity's RAM cost on the sampler.
 */
export const FACTION_REPS_PATH = "/var/faction_reps.txt";
export type FactionRepsFile = {
  reps: Record<string, number>;
  // The finish line (system/phase.ts's derivePhase): the hacking multiplier
  // (player x BitNode) against what Daedalus's hacking requirement needs.
  hackingMult?: number;
  requiredHackingMult?: number;
  // Everything to destroy the World Daemon is in place (readyToFinish), and
  // the BitNode the faction config's nextBitNode finishes into (0: none).
  finishReady?: boolean;
  nextBitNode?: number;
  // See favorPlan: factions being worked up to donation favor, and whether
  // all of them are there (time to install).
  favorPlan?: FavorPlanEntry[];
  favorPlanReady?: boolean;
  // The crime lowering karma for a gang (Approach.GANG), if any.
  karmaCrime?: string;
  // Rep still worth earning per joined faction (see repTargets) - what
  // sleeve_daemon.ts's sleeves work toward.
  repTargets?: Record<string, number>;
  // What the work slot is doing to earn a wanted invite (wantedInviteFactions), if anything.
  inviteAction?: string;
  workTarget?: string;
  workType?: string;
  // Rep/min for each work type the work target offers, by formula (see
  // bestWorkType) - `cat` the file to compare field work vs hacking contracts.
  workGains?: Record<string, number>;
  // The work slot is at the gym (a wanted invite's combat stats, or karma
  // crime training) - hacknet_daemon.ts spends hashes on Improve Gym
  // Training then, as it does for study_daemon.ts's gym sessions.
  gymTraining?: boolean;
  // Every favor-plan faction being ground (the player's and the sleeves'):
  // measured rep/min, time left, and what installing now would do
  // (installNowEstimate).
  grinds?: GrindStatus[];
  // Corporate factions worth joining (they sell augmentations still
  // wanted): company rep toward each invite. Sleeves work these companies
  // and the hacknet buys Company Favor for the nearest (companyTargets).
  companyTargets?: CompanyTarget[];
  // For tools/status.js --verbose: what blocks each wanted invite
  // (describeUnmetRequirements), favor per joined faction, the ones taking
  // donations, and installed augmentations (invites count these).
  inviteBlockers?: Record<string, string[]>;
  favors?: Record<string, number>;
  donatable?: string[];
  installedAugs?: number;
  writtenAt: number;
};

export type GrindStatus = {
  faction: string;
  gap: number;
  repPerMin: number;
  etaMinutes: number;
  favor: number;
  installFavor: number;
  installEtaMinutes: number;
};

/**
 * Whether installing now finishes the favor grinds sooner: the last one to
 * finish (they run in parallel - player and sleeves on different
 * factions) finishes earlier after the install (installNowEstimate: the
 * favor it banks speeds up the rest by more than the install costs).
 * Only favor targets count - they accumulate across installs, while rep
 * toward an augmentation's requirement is wiped by one.
 *
 * And some grind must bank at least MIN_INSTALL_FAVOR_GAIN favor: over a
 * long grind any sliver of favor "pays" by the estimate - BN9 installed
 * for Sector-12 at 884 of 461,717 rep (an 87-hour grind at 88 rep/min),
 * wiping the hacknet economy and the port programs for ~2% more rep/min.
 */
export function grindInstallPays(grinds: GrindStatus[] | undefined): boolean {
  if (!grinds || grinds.length === 0) return false;
  if (!grinds.some((g) => g.installFavor - g.favor >= MIN_INSTALL_FAVOR_GAIN)) return false;
  const lastNow = Math.max(...grinds.map((g) => g.etaMinutes));
  const lastAfter = Math.max(...grinds.map((g) => g.installEtaMinutes));
  return lastAfter < lastNow;
}

// Favor an install must bank for some grind (grindInstallPays). BN12's
// worthwhile favor installs banked ~8 each.
export const MIN_INSTALL_FAVOR_GAIN = 5;

/**
 * AUGMENTS' buy-and-install loop, written by faction_daemon.ts every tick.
 * While it's active an install is minutes away and wipes the Hacknet, so
 * hacknet_daemon.ts buys no nodes; once it's over (nothing left to buy but
 * NeuroFlux, or another mode) a long stretch without installs follows,
 * and building the Hacknet pays.
 */
/**
 * Whether the player's work slot is free, written by faction_daemon.ts
 * every tick. Free once no faction needs grinding (every favor target met,
 * the rest bought with donations), no invite needs work, and no karma
 * crime runs - study_daemon.ts then trains or studies with the time.
 */
export const WORK_SLOT_PATH = "/var/work_slot.txt";
export type WorkSlotFile = { free: boolean; writtenAt: number };

// Eligibility actions that occupy the work slot (the rest are instant).
const SLOT_CLAIMING_ELIGIBILITY = ["workForCompany", "gymWorkout", "commitCrime"];

export function workSlotFree(workTarget: string | undefined, inviteActionKind: string, karmaCrime: boolean, eligibilityActionKind: string): boolean {
  return !workTarget && inviteActionKind === "none" && !karmaCrime && !SLOT_CLAIMING_ELIGIBILITY.includes(eligibilityActionKind);
}

export const INSTALL_LOOP_PATH = "/var/install_loop.txt";
export type InstallLoopFile = { active: boolean; writtenAt: number };

/**
 * Whether the install loop is running: AUGMENTS with auto purchase and
 * auto install on, and something pending or still left to buy.
 */
export function installLoopActive(augmentsMode: boolean, autoPurchase: boolean, autoInstall: boolean, pendingCount: number, leftToBuy: boolean): boolean {
  return augmentsMode && autoPurchase && autoInstall && (pendingCount > 0 || leftToBuy);
}

/**
 * The work type earning the most rep, from ns.formulas.work.factionGains
 * for each type the faction offers. Which one wins depends on the player:
 * hacking contracts scale with hacking alone, field work with every stat,
 * so with combat stats at 1500 field work can beat hacking. Ties keep the
 * faction's own listing order. undefined for no types.
 */
export function bestWorkType(types: string[], repPerMin: Record<string, number>): string | undefined {
  let best: string | undefined;
  for (const type of types) if (best === undefined || (repPerMin[type] ?? 0) > (repPerMin[best] ?? 0)) best = type;
  return best;
}

/** "The Black Hand" -> "gauge/rep_the_black_hand" (lowercase, runs of non-alphanumerics to "_"). */
export function repSeriesId(faction: string): string {
  return `gauge/rep_${faction.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

export type AugmentationInfo = {
  name: string;
  faction: string;
  price: number;
  repReq: number;
  prereqs: string[];
  // ns.singularity.getAugmentationStats multipliers (e.g. hacking: 1.1);
  // optional so tests and callers that don't need them can omit it.
  stats?: Record<string, number>;
};

export type PurchaseDecision = { kind: "none" } | { kind: "buy"; faction: string; augmentation: string };

/** Invitations minus factions already joined, further narrowed by an optional allowlist (undefined = join everything invited). */
export function decideFactionsToJoin(invitations: string[], alreadyJoined: string[], allowlist?: string[]): string[] {
  const joined = new Set(alreadyJoined);
  return invitations.filter((faction) => !joined.has(faction) && (!allowlist || allowlist.includes(faction)));
}

/**
 * The catalog for each purpose, with NeuroFlux Governor decided in one
 * place. It's repeatable and always somewhat affordable, so before this it
 * got bought through every path - normal purchases, 90%-of-cash donations,
 * rep grinding at whichever faction had the smallest NeuroFlux gap - and
 * each purchase multiplied every other augmentation's price by 1.9 for the
 * rest of the cycle, QLink's included. Now it may only be bought when both:
 * 1. an install is about to happen (the `preInstall` catalog - so it's
 *    always the last thing bought, after every real augmentation), and
 * 2. its faction offers nothing else still wanted (not owned, not
 *    NeuroFlux) - so it never competes with, say, QLink at Illuminati.
 * `regular` (normal purchases, donations, what to work for) never has it.
 * `owned` should include pending purchases (getOwnedAugmentations(true)).
 */
export function catalogsFor(catalog: AugmentationInfo[], owned: string[]): { regular: AugmentationInfo[]; preInstall: AugmentationInfo[] } {
  const ownedSet = new Set(owned);
  const regular = catalog.filter((aug) => aug.name !== NEUROFLUX_GOVERNOR);
  const factionsWithOthers = new Set(regular.filter((aug) => !ownedSet.has(aug.name)).map((aug) => aug.faction));
  const lastResort = catalog.filter((aug) => aug.name === NEUROFLUX_GOVERNOR && !factionsWithOthers.has(aug.faction));
  return { regular, preInstall: [...regular, ...lastResort] };
}

/**
 * Augmentations worth rep or money at all: The Red Pill, or anything
 * raising one of `usefulStats` (multiplier keys; [] = everything). Every
 * buying, work-target, rep-target and favor-plan decision starts from this.
 * Before it, every augmentation counted - BN10 worked Netburners for rep
 * and bought its five Hacknet augmentations (5x price there, each raising
 * every later price 1.9x), none of which helps the run.
 */
export function usefulCatalog(catalog: AugmentationInfo[], usefulStats: string[]): AugmentationInfo[] {
  return catalog.filter((aug) => aug.name === RED_PILL || matchesFocus(aug.stats, usefulStats));
}

/**
 * Joined factions worth working for or planning favor at: all but the
 * gang's own faction. Its rep comes from gang respect (BN9's reached 58M
 * with nobody working it) and it can never take donations, so work or favor
 * there is wasted - BN10 had put Slum Snakes in the favor plan and made it
 * the player's work target.
 */
export function workableFactions(joinedFactions: string[], gangFaction: string | undefined): string[] {
  return joinedFactions.filter((faction) => faction !== gangFaction);
}

/** Not owned, and not the repeatable NeuroFlux Governor - an augmentation worth a faction's rep or favor. */
function isWanted(aug: AugmentationInfo, ownedSet: Set<string>): boolean {
  return aug.name !== NEUROFLUX_GOVERNOR && !ownedSet.has(aug.name);
}

/**
 * Rep to earn this run for a faction's favor to reach `targetFavor` at the
 * next install. Favor after an install comes from total rep ever earned
 * there, so this is the rep equivalent of the target minus that of today's
 * favor. `favorToRep` is ns.formulas.reputation.calculateFavorToRep.
 */
export function repForFavor(currentFavor: number, targetFavor: number, favorToRep: (favor: number) => number): number {
  return Math.max(0, favorToRep(targetFavor) - favorToRep(currentFavor));
}

export type FavorPlanEntry = { faction: string; augmentation: string; rep: number; target: number };

/**
 * Factions where building favor beats grinding: joined, below
 * `targetFavor` (ns.getFavorToDonate()), and selling a wanted augmentation
 * whose rep requirement is more than reaching that favor takes. Earning
 * just `target` rep, installing, and buying the rest with a donation is
 * then faster - what BN9's Daedalus/Red Pill run did by hand (462k rep
 * instead of 2.5M). `augmentation` is the one with the largest requirement.
 */
export function favorPlan(
  joinedFactions: string[],
  reps: Record<string, number>,
  favors: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[],
  targetFavor: number,
  favorToRep: (favor: number) => number
): FavorPlanEntry[] {
  const ownedSet = new Set(owned);
  const plan: FavorPlanEntry[] = [];
  for (const faction of joinedFactions) {
    const favor = favors[faction] ?? 0;
    if (favor >= targetFavor) continue;
    const target = repForFavor(favor, targetFavor, favorToRep);
    const worthIt = catalog.filter((aug) => aug.faction === faction && isWanted(aug, ownedSet) && aug.repReq > target);
    if (worthIt.length === 0) continue;
    const biggest = worthIt.reduce((a, b) => (b.repReq > a.repReq ? b : a));
    plan.push({ faction, augmentation: biggest.name, rep: reps[faction] ?? 0, target });
  }
  return plan;
}

/**
 * Whether the BitNode can be finished now: The Red Pill installed (not
 * just bought), the World Daemon visible, and hacking at its requirement.
 * BN12's first run sat ready for 40 minutes: nothing finished it, by
 * design, until someone noticed.
 */
export function readyToFinish(redPillInstalled: boolean, worldDaemonVisible: boolean, hackingLevel: number, requiredLevel: number): boolean {
  return redPillInstalled && worldDaemonVisible && hackingLevel >= requiredLevel;
}

/**
 * FACTION_GRIND's single favor target: the faction (not the gang's - it
 * can't take donations) needing the least rep this run to reach donation
 * favor at the next install. Donation favor anywhere turns money into rep
 * there - NeuroFlux Governor levels and everything else it sells - which
 * favorPlan alone never aimed at: it only counted factions selling one
 * particular augmentation dearer than the favor, and BN12 went 15 hours
 * without a single donatable faction. undefined when one already is.
 */
export function donationTarget(
  workable: string[],
  reps: Record<string, number>,
  favors: Record<string, number>,
  targetFavor: number,
  favorToRep: (favor: number) => number
): FavorPlanEntry | undefined {
  if (workable.some((faction) => (favors[faction] ?? 0) >= targetFavor)) return undefined;
  let best: FavorPlanEntry | undefined;
  for (const faction of workable) {
    const target = repForFavor(favors[faction] ?? 0, targetFavor, favorToRep);
    const entry = { faction, augmentation: NEUROFLUX_GOVERNOR, rep: reps[faction] ?? 0, target };
    if (!best || entry.target - entry.rep < best.target - best.rep) best = entry;
  }
  return best;
}

/**
 * Whether FACTION_GRIND may install: every favor target met (or none to
 * meet), or an install now finishes the current grind sooner
 * (grindInstallPays). Favor grows with the log of rep, so the first rep of
 * a run banks the most favor, and each install speeds up the rest: BN10's
 * BitRunners grind went from 6.0h to 3.4h by installing at 106K of 462K.
 */
export function grindAllowsInstall(plan: FavorPlanEntry[], grinds?: GrindStatus[]): boolean {
  return plan.every((entry) => entry.rep >= entry.target) || grindInstallPays(grinds);
}

/** Every planned faction has reached its favor target - installing now banks the favor. False for an empty plan. */
export function favorPlanReady(plan: FavorPlanEntry[]): boolean {
  return plan.length > 0 && plan.every((entry) => entry.rep >= entry.target);
}

/**
 * Factions from `candidates` (config) worth joining: not joined yet, and
 * offering at least one wanted augmentation. `offered` maps each faction to
 * ns.singularity.getAugmentationsFromFaction - it works for unjoined
 * factions too.
 */
export function wantedInviteFactions(
  candidates: string[],
  joinedFactions: string[],
  offered: Record<string, string[]>,
  owned: string[],
  alsoWanted: string[] = []
): string[] {
  const ownedSet = new Set(owned);
  const byAugmentations = candidates.filter(
    (faction) => !joinedFactions.includes(faction) && (offered[faction] ?? []).some((name) => name !== NEUROFLUX_GOVERNOR && !ownedSet.has(name))
  );
  // `alsoWanted`: worth joining for something other than augmentations -
  // The Covenant while BitNode 10 still sells sleeves there.
  const extra = alsoWanted.filter((faction) => !joinedFactions.includes(faction) && !byAugmentations.includes(faction));
  return [...byAugmentations, ...extra];
}

/**
 * Which joined faction to work for right now: whichever has the smallest
 * positive reputation gap to its next still-wanted augmentation - working
 * there finishes something soonest, rather than spreading effort thin
 * across every faction at once. A faction with nothing left to unlock
 * (every offering owned, or none left needing more rep) isn't returned.
 *
 * Exception: The Red Pill. While a joined faction offers it (Daedalus),
 * it isn't owned, and its rep isn't there yet, that faction wins outright -
 * finishing the BitNode outranks every other augmentation, and a nearly-
 * reached NeuroFlux Governor elsewhere would otherwise keep winning on gap.
 *
 * Then `plan` (favorPlan): a faction still short of its favor target wins
 * next, the closest one first, so each gets worked only as far as the favor
 * needs and the work slot moves on.
 *
 * Rep is only ever ground up to the point where cash takes over: a planned
 * faction (Daedalus too) stops at its favor target, the rest bought by
 * donation after the next install, and a `donatable` faction (favor
 * already there) is never worked at all. Past that the work slot is free
 * for training (see WorkSlotFile).
 */
export function decideWorkTarget(
  joinedFactions: string[],
  reps: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[],
  plan: FavorPlanEntry[] = [],
  donatable: Set<string> = new Set()
): string | undefined {
  const ownedSet = new Set(owned);
  const grindable = joinedFactions.filter((faction) => !donatable.has(faction));
  const planFor = (faction: string): FavorPlanEntry | undefined => plan.find((entry) => entry.faction === faction);

  const redPill = catalog.find(
    (aug) =>
      aug.name === RED_PILL &&
      grindable.includes(aug.faction) &&
      !ownedSet.has(aug.name) &&
      (reps[aug.faction] ?? 0) < (planFor(aug.faction)?.target ?? aug.repReq)
  );
  if (redPill) return redPill.faction;

  const unfinished = plan.filter((entry) => entry.rep < entry.target && grindable.includes(entry.faction));
  if (unfinished.length > 0) return unfinished.reduce((a, b) => (b.target - b.rep < a.target - a.rep ? b : a)).faction;

  let best: { faction: string; gap: number } | undefined;
  for (const faction of grindable) {
    // A planned faction stops at its favor target: the rest is bought with a donation after the next install.
    if (planFor(faction)) continue;
    const currentRep = reps[faction] ?? 0;
    const gaps = catalog
      .filter((aug) => aug.faction === faction && isWanted(aug, ownedSet))
      .map((aug) => aug.repReq - currentRep)
      .filter((gap) => gap > 0);

    if (gaps.length === 0) continue;
    const smallestGap = Math.min(...gaps);
    if (!best || smallestGap < best.gap) best = { faction, gap: smallestGap };
  }

  return best?.faction;
}

/**
 * Most EXPENSIVE augmentation that's affordable, has its reputation
 * requirement met, and has every prereq already owned - deliberately
 * the opposite of the obvious "cheapest first" greedy shape. The game's
 * price inflation (confirmed via Bitburner's own AugmentationHelpers.ts/
 * Constants.ts: each purchase multiplies every remaining unpurchased
 * augmentation's price by 1.9, permanently, for the rest of this batch)
 * applies to whichever augmentation is bought at position k regardless
 * of which one it is - so for a FIXED set you're going to buy anyway,
 * the order changes the total cost. By the rearrangement inequality,
 * pairing the largest prices with the smallest multiplier (buy expensive
 * first, cheap last) minimizes total spend: three augmentations priced
 * $10/$100/$1000 cost $3810 bought cheapest-first (10×1.9⁰ + 100×1.9¹ +
 * 1000×1.9²) versus $1226 bought priciest-first (1000×1.9⁰ + 100×1.9¹ +
 * 10×1.9²) - under a third as much for the identical set. This also
 * fixes the "cheap purchase inflates a soon-to-unlock better one's
 * price for no benefit" problem without needing to model projected rep
 * gain rates: buying whatever's most valuable *whenever it first
 * becomes eligible* already front-loads value ahead of the multiplier,
 * which is the actual goal a rep-timing lookahead would have been
 * chasing. Price is used as the value proxy (no augmentation "power"
 * metric exists to compare against) - same "simplest reasonable v1"
 * tradeoff as everywhere else in this codebase. `owned` should include
 * augmentations already purchased-but-not-yet-installed this session
 * (see ns.singularity.getOwnedAugmentations(true)) so a prereq bought
 * earlier this run counts immediately, and so we don't try to buy the
 * same (non-repeatable) augmentation twice before an install.
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

  const mostExpensive = eligible.reduce((best, aug) => (aug.price > best.price ? aug : best));
  return { kind: "buy", faction: mostExpensive.faction, augmentation: mostExpensive.name };
}

export type DonationDecision = { kind: "none" } | { kind: "donate"; faction: string; augmentation: string; amount: number };

/**
 * Buys the missing reputation for an augmentation with money
 * (ns.singularity.donateToFaction), once nothing is purchasable outright.
 * Only for factions in `donatable` - favor >= getFavorToDonate(), and never
 * the gang's own faction, which can't take donations.
 *
 * An augmentation qualifies if its prereqs are owned (the same rules as
 * decideAugmentationPurchase) and donating its rep gap *plus* its price fits
 * the budget - a donation that leaves the augmentation itself unaffordable
 * would just burn money. Among those, the most expensive augmentation wins,
 * for the same price-inflation reason decideAugmentationPurchase buys the
 * priciest first. Ties (NeuroFlux Governor, offered by several donatable
 * factions at the same price) go to the smallest donation - the faction
 * already closest to the requirement.
 *
 * `donationForRep` is ns.formulas.reputation.donationForRep in the daemon,
 * injected so this stays `ns`-free.
 */
export function decideDonation(
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  reps: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[],
  donatable: Set<string>,
  donationForRep: (rep: number) => number
): DonationDecision {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));
  const ownedSet = new Set(owned);

  const candidates = catalog
    .filter((aug) => {
      if (!donatable.has(aug.faction)) return false;
      if (aug.name !== NEUROFLUX_GOVERNOR && ownedSet.has(aug.name)) return false;
      if (!aug.prereqs.every((prereq) => ownedSet.has(prereq))) return false;
      return (reps[aug.faction] ?? 0) < aug.repReq;
    })
    .map((aug) => ({ aug, amount: donationForRep(aug.repReq - (reps[aug.faction] ?? 0)) }))
    .filter(({ aug, amount }) => amount + aug.price <= budget);

  if (candidates.length === 0) return { kind: "none" };

  const best = candidates.reduce((a, b) =>
    b.aug.price > a.aug.price || (b.aug.price === a.aug.price && b.amount < a.amount) ? b : a
  );
  return { kind: "donate", faction: best.aug.faction, augmentation: best.aug.name, amount: best.amount };
}

/**
 * The Red Pill, when it should be the only thing bought or donated for: not
 * owned, offered by a joined faction, and either its rep is already met
 * (buy it - it costs $0) or that faction takes donations (save up and buy
 * the rep). decideAugmentationPurchase/decideDonation rank by price, so
 * without this a $0 Red Pill lost to every repeatable NeuroFlux donation
 * elsewhere, which would keep spending the cash it needs. undefined while
 * it's only reachable by grinding rep - nothing to save for then.
 */
export function redPillFocus(
  catalog: AugmentationInfo[],
  reps: Record<string, number>,
  owned: string[],
  donatable: Set<string>
): AugmentationInfo | undefined {
  if (owned.includes(RED_PILL)) return undefined;
  return catalog.find((aug) => aug.name === RED_PILL && ((reps[aug.faction] ?? 0) >= aug.repReq || donatable.has(aug.faction)));
}

/**
 * The one augmentation to save for and buy in Approach.AUGMENTS: The Red
 * Pill if redPillFocus picks it, else the most EXPENSIVE wanted augmentation
 * (not owned, not NeuroFlux, prereqs owned) that raises a multiplier in
 * `focus` and is reachable this install cycle - rep already met, or its
 * faction takes donations. Most expensive first for the same 1.9x
 * price-inflation reason as decideAugmentationPurchase, but *held*: nothing
 * cheaper gets bought while it's unaffordable, because each purchase would
 * make it 1.9x dearer (QLink at $25T became ~$90T behind two cheap buys).
 * Unreachable augmentations don't hold anything - they can't be bought
 * before the next install resets the inflation anyway. An empty `focus`
 * means only The Red Pill counts.
 */
export function priorityFocus(
  catalog: AugmentationInfo[],
  reps: Record<string, number>,
  owned: string[],
  donatable: Set<string>,
  focus: string[],
  maxPrice = Infinity,
  cheapest = false
): AugmentationInfo | undefined {
  const redPill = redPillFocus(catalog, reps, owned, donatable);
  if (redPill || focus.length === 0) return redPill;

  const ownedSet = new Set(owned);
  const reachable = catalog.filter(
    (aug) =>
      isWanted(aug, ownedSet) &&
      matchesFocus(aug.stats, focus) &&
      aug.prereqs.every((prereq) => ownedSet.has(prereq)) &&
      ((reps[aug.faction] ?? 0) >= aug.repReq || donatable.has(aug.faction)) &&
      aug.price <= maxPrice
  );
  if (reachable.length === 0) return undefined;
  return reachable.reduce((a, b) => (cheapest ? b.price < a.price : b.price > a.price) ? b : a);
}

/**
 * The stats that decide what's bought, or undefined for no narrowing
 * (outside GROW_STATS/AUGMENTS). `focus` normally; `fallback` (every useful
 * stat) once `focusExhausted` - no focus augmentation left reachable at any
 * price - so AUGMENTS keeps buying instead of stalling with cash and rep.
 */
export function focusStatsFor(narrowed: boolean, focusExhausted: boolean, focus: string[], fallback: string[]): string[] | undefined {
  if (!narrowed) return undefined;
  return focusExhausted ? fallback : focus;
}

/**
 * The most an AUGMENTS focus may cost: cash plus `maxMinutes` of income
 * (Infinity when income is unknown or there is no limit). Each purchase
 * raises every later price 1.9x, so past some point reinstalling (which
 * resets that, while the gang keeps earning) beats saving. priorityFocus
 * picks the most expensive augmentation under it, so each cycle buys the
 * dearest reachable ones first, while prices are lowest.
 */
/** focusPriceLimit's minimum horizon while nothing is pending. */
export const NOTHING_PENDING_MIN_MINUTES = 60;

export function focusPriceLimit(money: number, incomePerMin: number | undefined, maxMinutes: number, pendingCount = 1): number {
  if (incomePerMin === undefined || maxMinutes <= 0) return Infinity;
  // Nothing pending: prices are at base and an install can't make anything
  // cheaper, so allow a longer save - an hour at least (the caller falls
  // back to the cheapest reachable when even that finds nothing). A plain
  // 5-minute cap here once stalled BN10's loop (nothing saved for, bought
  // or installed while servers spent the cash); no cap at all then saved
  // 6.3h for one $126T QLink.
  const minutes = pendingCount === 0 ? Math.max(NOTHING_PENDING_MIN_MINUTES, maxMinutes * 12) : maxMinutes;
  return money + Math.max(0, incomePerMin) * minutes;
}

/**
 * Augmentations bought but not yet installed: `ownedWithQueued`
 * (getOwnedAugmentations(true)) minus `installed` (getOwnedAugmentations(false))
 * as a multiset - one queued copy per name is removed for each installed
 * one. A plain name filter dropped a queued NeuroFlux Governor whenever one
 * was already installed, so pending read 0 and auto-install never fired.
 */
export function pendingAugmentations(ownedWithQueued: string[], installed: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const name of installed) remaining.set(name, (remaining.get(name) ?? 0) + 1);
  return ownedWithQueued.filter((name) => {
    const left = remaining.get(name) ?? 0;
    if (left === 0) return true;
    remaining.set(name, left - 1);
    return false;
  });
}

/**
 * True once this tick found nothing left worth buying and something
 * purchased-but-uninstalled is actually waiting to be installed - and no
 * cash reserve is set. An install resets cash to $1,000, which breaks any
 * reserveMoney floor; worse, with a reserve set "nothing affordable" just
 * means "the reserve blocked it", not "done buying". That combination once
 * spent a $100B Daedalus savings on augmentations and installed. So while
 * reserveMoney > 0, installs wait.
 */
/**
 * The cheapest augmentation buyable right now (rep met, prereqs owned,
 * affordable; NeuroFlux counts), bought only so an install that's wanted
 * can happen - the game won't install with nothing pending. BN10 sat 18.7h
 * with The Covenant and BitRunners one install away from donation favor:
 * nothing wanted was buyable, NeuroFlux was only allowed in the pre-install
 * spend-down, and that only starts once something is pending.
 */
export function pickInstallEnabler(catalog: AugmentationInfo[], reps: Record<string, number>, owned: string[], money: number): AugmentationInfo | undefined {
  const ownedSet = new Set(owned);
  const buyable = catalog.filter(
    (aug) =>
      (aug.name === NEUROFLUX_GOVERNOR || !ownedSet.has(aug.name)) &&
      (reps[aug.faction] ?? 0) >= aug.repReq &&
      aug.prereqs.every((p) => ownedSet.has(p)) &&
      aug.price <= money
  );
  return buyable.length === 0 ? undefined : buyable.reduce((a, b) => (b.price < a.price ? b : a));
}

export function decideInstallReady(purchaseDecision: PurchaseDecision, pendingAugmentations: string[], reserveMoney: number): boolean {
  return reserveMoney <= 0 && purchaseDecision.kind === "none" && pendingAugmentations.length > 0;
}

/**
 * The last steps before an install, once decideInstallReady is true.
 * An install resets cash to $1,000 and deletes every stock position with no
 * refund (see system/install_handshake.ts), so anything
 * still spendable is spent first:
 *
 * - `finalPurchase` is decided with the *whole* cash balance (no
 *   reserveMoney, no maxSpendFraction). Those throttles protect money for
 *   later, and there is no later - the old daily budget would leave up to
 *   half the cash on the table at install. Anything affordable gets bought.
 * - With nothing left to buy but stock still held, wind down: stock_daemon
 *   sells, and the freed cash comes back through `finalPurchase` next tick.
 * - Only with nothing affordable and no stock held does the install happen.
 */
export type PreInstallAction = { kind: "buy"; faction: string; augmentation: string } | { kind: "wind-down" } | { kind: "install" };

export function decidePreInstall(finalPurchase: PurchaseDecision, stockPositionsHeld: number): PreInstallAction {
  if (finalPurchase.kind === "buy") return finalPurchase;
  if (stockPositionsHeld > 0) return { kind: "wind-down" };
  return { kind: "install" };
}

/**
 * Active faction eligibility: everything above only ever reacts to
 * ns.singularity.checkFactionInvitations() - it never does anything to
 * become eligible for a faction we're not yet invited to. This section
 * adds that, for three categories the player chose (city, company,
 * criminal/gang factions) after reviewing Bitburner's full faction
 * requirement list.
 *
 * Key discovery this is all built on:
 * ns.singularity.getFactionInviteRequirements(faction) returns the exact,
 * structured, live PlayerRequirement[] tree the game itself evaluates for
 * that invite (confirmed against NetscriptDefinitions.d.ts's own worked
 * example for "The Syndicate"). So nothing here hardcodes a threshold
 * (money amount, rep floor, stat level) - it reads the live tree and
 * reacts, the same "derive from live game data, don't duplicate a table"
 * taste already used by pickWorkType (faction_daemon.ts) and
 * hacknet_daemon.ts's HashUpgradeName derivation. The one type-only
 * import below (`PlayerRequirement`) is erased at compile time, so it's
 * no different from faction_daemon.ts's existing type-level use of `NS`
 * for FactionNameType/FactionWorkTypeType in an otherwise `ns`-free file.
 *
 * getFactionInviteRequirements's own doc example also revealed the real
 * shape: each combat stat arrives as its OWN top-level `skills` entry
 * (`{type:"skills", skills:{strength:200}}`), not one entry with all four
 * - see findBlockingRequirement's "largest gap" comment below for why
 * that matters.
 */
export const CITY_FACTION_NAMES = ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"];

export const COMPANY_FACTION_NAMES = [
  "ECorp",
  "MegaCorp",
  "Bachman & Associates",
  "Blade Industries",
  "NWO",
  "Clarke Incorporated",
  "OmniTek Incorporated",
  "Four Sigma",
  "KuaiGong International",
  "Fulcrum Secret Technologies",
];

// The one faction/employer name mismatch (confirmed via
// NetscriptDefinitions.d.ts's CompanyName/FactionName enums) - every
// other company-affiliated faction shares an identical string with its
// employer, so this is the only entry needed.
export const COMPANY_FACTION_EMPLOYER: Record<string, string> = {
  "Fulcrum Secret Technologies": "Fulcrum Technologies",
};

export const CRIMINAL_FACTION_NAMES = [
  "Slum Snakes",
  "Tetrads",
  "Silhouette",
  "The Syndicate",
  "The Dark Army",
  "Speakers for the Dead",
];

export type CombatStat = "strength" | "defense" | "dexterity" | "agility";
export const COMBAT_STATS: CombatStat[] = ["strength", "defense", "dexterity", "agility"];

export type EligibilitySnapshot = {
  money: number;
  skills: Record<"hacking" | CombatStat | "charisma" | "intelligence", number>;
  karma: number;
  numPeopleKilled: number;
  city: string;
  // ns.getPlayer().jobs is a Partial<Record<CompanyName, JobName>> -
  // Partial here for the same reason (no need to force every company key
  // to exist just to check membership).
  jobs: Partial<Record<string, string>>;
  // Populated per-candidate by the daemon (only for whichever company is
  // actually being evaluated that tick), not eagerly for all ten.
  companyReps: Record<string, number>;
};

export type EligibilityAction =
  | { kind: "none" }
  | { kind: "travel"; city: string }
  | { kind: "applyToCompany"; company: string; field: string }
  | { kind: "workForCompany"; company: string }
  | { kind: "quitJob"; company: string }
  | { kind: "gymWorkout"; stat: CombatStat }
  // `crime` is left "" here - picking an actual crime needs live
  // ns.singularity.getCrimeStats/getCrimeChance data this pure function
  // has no access to; faction_daemon.ts's pursueCriminalFactions resolves
  // it (via decideCrimeForKills below) before this action is ever acted on.
  | { kind: "commitCrime"; crime: string };

function isCombatStat(stat: string): stat is CombatStat {
  return (COMBAT_STATS as readonly string[]).includes(stat);
}

/**
 * Recursively evaluates one PlayerRequirement against a snapshot. This
 * only ever informs *which action to try next* - it never gates an actual
 * join (checkFactionInvitations() stays the sole join authority,
 * unchanged by any of this).
 *
 * Unmodeled leaf types (jobTitle, location, file, numAugmentations,
 * hacknet totals, bitNodeN, sourceFile, bladeburnerRank,
 * numInfiltrations) return `true` - an optimistic default. Known accepted
 * limitation: a someCondition mixing an unmodeled leaf with an actionable
 * one could report "satisfied" via the unmodeled leaf and skip a real
 * actionable alternative branch. No in-scope faction is known to hit
 * this.
 */
export function evaluateRequirement(req: PlayerRequirement, snapshot: EligibilitySnapshot): boolean {
  switch (req.type) {
    case "money":
      return snapshot.money >= req.money;
    case "skills":
      return Object.entries(req.skills).every(
        ([stat, level]) => (snapshot.skills[stat as keyof EligibilitySnapshot["skills"]] ?? 0) >= (level ?? 0)
      );
    case "karma":
      // Doc: "Player must have less than this much karma" - karma only
      // ever moves negative, so this is a ceiling, not a floor.
      return snapshot.karma <= req.karma;
    case "numPeopleKilled":
      return snapshot.numPeopleKilled >= req.numPeopleKilled;
    case "employedBy":
      return snapshot.jobs[req.company] !== undefined;
    case "companyReputation":
      return (snapshot.companyReps[req.company] ?? 0) >= req.reputation;
    case "city":
      return snapshot.city === req.city;
    case "not":
      return !evaluateRequirement(req.condition, snapshot);
    case "someCondition":
      return req.conditions.some((condition) => evaluateRequirement(condition, snapshot));
    case "everyCondition":
      return req.conditions.every((condition) => evaluateRequirement(condition, snapshot));
    default:
      return true;
  }
}

/** Whether this function knows how to turn an unsatisfied `req` into a concrete EligibilityAction at all. */
function isActionableRequirement(req: PlayerRequirement): boolean {
  switch (req.type) {
    case "city":
    case "employedBy":
    case "companyReputation":
    case "numPeopleKilled":
      return true;
    case "skills":
      return Object.keys(req.skills).some(isCombatStat);
    case "not":
      return req.condition.type === "employedBy";
    default:
      return false;
  }
}

/** Every unsatisfied combat-stat gap `req` describes (almost always exactly one, per getFactionInviteRequirements's real per-stat-entry shape - see module doc). */
function combatSkillGaps(req: PlayerRequirement, snapshot: EligibilitySnapshot): { stat: CombatStat; gap: number }[] {
  if (req.type !== "skills") return [];
  return Object.entries(req.skills)
    .filter(([stat]) => isCombatStat(stat))
    .map(([stat, level]) => ({ stat: stat as CombatStat, gap: (level ?? 0) - snapshot.skills[stat as CombatStat] }))
    .filter((entry) => entry.gap > 0);
}

/**
 * Flattens the implicitly-ANDed top-level array (and nested
 * everyCondition) into every unsatisfied, actionable leaf found, left to
 * right. For someCondition: skipped entirely if already satisfied via any
 * branch; otherwise only its first actionable-and-unsatisfied branch is
 * taken (no lookahead across alternative branches - matches this
 * codebase's "no lookahead" house style elsewhere, e.g.
 * decideAugmentationPurchase's per-tick re-derivation).
 */
function collectUnsatisfiedActionable(requirements: PlayerRequirement[], snapshot: EligibilitySnapshot): PlayerRequirement[] {
  const found: PlayerRequirement[] = [];
  for (const req of requirements) {
    if (req.type === "everyCondition") {
      found.push(...collectUnsatisfiedActionable(req.conditions, snapshot));
      continue;
    }
    if (req.type === "someCondition") {
      if (evaluateRequirement(req, snapshot)) continue;
      const branch = req.conditions.find((c) => isActionableRequirement(c) && !evaluateRequirement(c, snapshot));
      if (branch) found.push(branch);
      continue;
    }
    if (!isActionableRequirement(req) || evaluateRequirement(req, snapshot)) continue;
    found.push(req);
  }
  return found;
}

/**
 * The single requirement to act on next for one faction's invite, or
 * undefined if nothing actionable is blocking (either fully satisfied, or
 * blocked only by something this feature can't act on, e.g. still-
 * accumulating money or Silhouette's executive jobTitle). Non-skill
 * actionable requirements are returned in original left-to-right scan
 * order - e.g. an unresolved `not(employedBy)` always wins over combat
 * training, even if a later skills entry has a larger gap, since it's an
 * earlier, unrelated, and typically cheaper-to-clear blocker (quitJob is
 * instant; gym training is not).
 *
 * Combat-stat requirements only get special handling once the scan has
 * actually reached them - i.e. `unsatisfied[0]` itself is a `skills`
 * entry, meaning every earlier blocker is already satisfied or
 * non-actionable. At that point, since all 4 stats must clear an AND and
 * each arrives as its own separate `skills` entry (see module doc), the
 * slowest stat is the actual bottleneck - so among every unsatisfied
 * combat-stat entry found anywhere in the list, this returns whichever
 * has the LARGEST remaining gap, not the first-found or smallest. This
 * is deliberately the mirror image of decideWorkTarget's "smallest gap
 * wins" - there only one thing needs to finish; here the *last* one to
 * finish is what determines when the whole requirement clears (same
 * "obvious first guess is wrong" style as decideAugmentationPurchase's
 * rearrangement-inequality doc).
 */
export function findBlockingRequirement(requirements: PlayerRequirement[], snapshot: EligibilitySnapshot): PlayerRequirement | undefined {
  const unsatisfied = collectUnsatisfiedActionable(requirements, snapshot);
  if (unsatisfied.length === 0) return undefined;

  if (unsatisfied[0].type === "skills") {
    const skillGaps = unsatisfied.flatMap((req) => combatSkillGaps(req, snapshot).map((gap) => ({ req, ...gap })));
    if (skillGaps.length > 0) {
      return skillGaps.reduce((worst, entry) => (entry.gap > worst.gap ? entry : worst)).req;
    }
  }

  return unsatisfied[0];
}

/**
 * Whether combat stats are all that's left for an invite: every other
 * requirement (money, hacking level, augmentation count, ...) is already
 * met. Invite pursuit only spends gym time then - training combat for
 * Illuminati while its $150B and hacking 1500 are hours away is wasted (and,
 * at a fresh BitNode's ~$1,000, unaffordable).
 */
export function onlyCombatLeft(requirements: PlayerRequirement[], snapshot: EligibilitySnapshot): boolean {
  return requirements.every((req) => {
    if (req.type === "everyCondition") return onlyCombatLeft(req.conditions, snapshot);
    if (req.type === "skills") {
      return Object.entries(req.skills)
        .filter(([stat]) => !isCombatStat(stat))
        .every(([stat, level]) => (snapshot.skills[stat as keyof EligibilitySnapshot["skills"]] ?? 0) >= (level ?? 0));
    }
    return evaluateRequirement(req, snapshot);
  });
}

/**
 * The largest unmet cash requirement in an invite's requirement list (0 if
 * none) - top level and everyCondition only, same scope as the rest of this
 * engine's AND handling. Money isn't something requirementToAction can act
 * on, so faction_daemon.ts turns this into a savings target instead (in
 * Approach.AUGMENTS), rather than letting other spending keep cash below it.
 */
export function unmetMoneyRequirement(requirements: PlayerRequirement[], snapshot: EligibilitySnapshot): number {
  let needed = 0;
  for (const req of requirements) {
    if (req.type === "money" && snapshot.money < req.money) needed = Math.max(needed, req.money);
    if (req.type === "everyCondition") needed = Math.max(needed, unmetMoneyRequirement(req.conditions, snapshot));
  }
  return needed;
}

/**
 * Pure mapping from one blocking requirement to one concrete action.
 * `commitCrime`'s crime name is deliberately left "" here - see
 * EligibilityAction's doc comment above.
 */
export function requirementToAction(req: PlayerRequirement, companyJobField: string, snapshot: EligibilitySnapshot): EligibilityAction {
  switch (req.type) {
    case "city":
      return { kind: "travel", city: req.city };
    case "employedBy":
      return { kind: "applyToCompany", company: req.company, field: companyJobField };
    case "companyReputation":
      return { kind: "workForCompany", company: req.company };
    case "not":
      return req.condition.type === "employedBy" ? { kind: "quitJob", company: req.condition.company } : { kind: "none" };
    case "numPeopleKilled":
      return { kind: "commitCrime", crime: "" };
    case "skills": {
      const gaps = combatSkillGaps(req, snapshot);
      if (gaps.length === 0) return { kind: "none" };
      const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
      return { kind: "gymWorkout", stat: worst.stat };
    }
    default:
      return { kind: "none" };
  }
}

/**
 * Picks the crime maximizing `kills` among those with `successChance >=
 * minSuccessChance` - data-driven over whatever getCrimeStats/
 * getCrimeChance report for each live CrimeType, never a hardcoded
 * "Homicide" string (same "derive, don't hardcode" reasoning as
 * pickWorkType). `minSuccessChance` is a safety floor so the daemon never
 * grinds a crime with a poor success chance indefinitely.
 */
export function decideCrimeForKills(
  candidates: { crime: string; kills: number; successChance: number }[],
  minSuccessChance: number
): string | undefined {
  const eligible = candidates.filter((c) => c.kills > 0 && c.successChance >= minSuccessChance);
  if (eligible.length === 0) return undefined;
  return eligible.reduce((best, c) => (c.kills > best.kills ? c : best)).crime;
}

/**
 * The crime that lowers karma fastest: karma per success x success chance
 * / time (getCrimeStats' karma and time, getCrimeChance). Used by
 * Approach.GANG to reach the gang karma requirement. Early on Homicide's
 * big karma loses to safer crimes it can't yet succeed at; as combat stats
 * rise (crimes build them) it takes over. undefined when nothing can
 * succeed at all.
 */
export function pickKarmaCrime(candidates: { crime: string; karma: number; timeMs: number; successChance: number }[]): string | undefined {
  const rate = (c: (typeof candidates)[number]): number => (c.timeMs > 0 ? (c.karma * c.successChance) / c.timeMs : 0);
  const viable = candidates.filter((c) => rate(c) > 0);
  if (viable.length === 0) return undefined;
  return viable.reduce((best, c) => (rate(c) > rate(best) ? c : best)).crime;
}

/**
 * Whether to train at the gym instead of committing the karma crime, and
 * which stat: the weakest combat stat while the crime's success chance is
 * below `minChance`. Each failure costs the crime's full time for no karma,
 * and the gym raises combat stats far faster than crimes do - BN10's first
 * gang run measured ~0.5 karma/s at ~50% Homicide success, about half the
 * rate at full success. The chance only rises while training, so this
 * doesn't flip back and forth.
 */
export function gangTrainingStat(
  crimeChance: number,
  minChance: number,
  skills: EligibilitySnapshot["skills"],
  chanceWithBoost?: (stat: CombatStat) => number
): CombatStat | undefined {
  if (crimeChance >= minChance) return undefined;
  // With the formulas (chanceWithBoost: the crime's success chance with that
  // stat raised a little), train whichever stat raises the chance most - the
  // crime weights the four stats differently, so the weakest can be the one
  // that helps least. Without them, the weakest.
  if (chanceWithBoost) return COMBAT_STATS.reduce((best, stat) => (chanceWithBoost(stat) > chanceWithBoost(best) ? stat : best));
  return COMBAT_STATS.reduce((weakest, stat) => (skills[stat] < skills[weakest] ? stat : weakest));
}

/**
 * Rep worth reaching at each joined faction: its favor-plan target (see
 * favorPlan; met means done - donations cover the rest after the install),
 * otherwise the largest requirement among its wanted augmentations (not
 * owned, not NeuroFlux). Donatable factions are skipped. Only factions
 * still short of it are listed. Published for sleeve_daemon.ts, so sleeves earn
 * rep where it buys something, without re-deriving the faction logic.
 */
export function repTargets(
  joinedFactions: string[],
  reps: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[],
  plan: FavorPlanEntry[],
  donatable: Set<string> = new Set()
): Record<string, number> {
  const ownedSet = new Set(owned);
  const targets: Record<string, number> = {};
  for (const faction of joinedFactions) {
    if (donatable.has(faction)) continue;
    const rep = reps[faction] ?? 0;
    const planned = plan.find((entry) => entry.faction === faction);
    const wanted = catalog.filter((aug) => aug.faction === faction && isWanted(aug, ownedSet)).map((aug) => aug.repReq);
    const target = planned ? planned.target : wanted.length > 0 ? Math.max(...wanted) : 0;
    if (target > rep) targets[faction] = target;
  }
  return targets;
}

/**
 * Whether a stretch of gym training reaches the gang karma requirement
 * sooner than committing the crime now: time at today's karma rate versus
 * the training time plus the time at the improved rate. Rate = karma per
 * success x success chance / crime time. Replaces a fixed "train below 80%"
 * rule, which in BN10 (combat levels x0.4) meant hours of gym at 64 in every
 * stat with no karma progress.
 */
export function trainingPaysOff(
  remainingKarma: number,
  karmaPerSuccess: number,
  crimeTimeMs: number,
  chanceNow: number,
  chanceAfter: number,
  trainMs: number
): boolean {
  const rate = (chance: number): number => (karmaPerSuccess * chance) / crimeTimeMs;
  if (!(rate(chanceAfter) > 0) || !Number.isFinite(trainMs)) return false;
  if (!(rate(chanceNow) > 0)) return true;
  return remainingKarma / rate(chanceNow) > trainMs + remainingKarma / rate(chanceAfter);
}

/** Trivial mirror of gang_decisions.ts's decideStandDown - bounds crime-for-kills grinding via /var/faction_state.txt's crimeAttempts. */
export function decideEligibilityStandDown(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/** Once any one city faction is joined, the whole category stops (see faction_daemon.ts's pursueCityFactions doc for why). */
export function hasAnyCityFaction(joinedFactions: string[]): boolean {
  return CITY_FACTION_NAMES.some((faction) => joinedFactions.includes(faction));
}

/** The shared savings reason while saving for a Covenant sleeve - sleeve_daemon.ts buys it with the full balance. */
export const SLEEVE_SAVINGS_REASON = "Covenant sleeve";

/**
 * Cash to save for the next Covenant sleeve, or 0. BitNode 10 only (the
 * only place they're sold), as a Covenant member, when it's within
 * `maxMinutes` of income (cash counts). A sleeve is permanent - it carries
 * into every later BitNode - so once it's that close it outranks
 * augmentations and servers, which otherwise keep cash from ever reaching
 * the price (each sleeve costs 10x the last: the fourth is $10Q). Unknown
 * income saves only once cash alone covers it.
 */
export function sleeveSavings(
  node: number | undefined,
  covenantMember: boolean,
  nextSleeveCost: number | undefined,
  money: number,
  incomePerMin: number | undefined,
  maxMinutes: number
): number {
  if (node !== 10 || !covenantMember || !(maxMinutes > 0) || nextSleeveCost === undefined || !Number.isFinite(nextSleeveCost)) return 0;
  const reach = money + Math.max(0, incomePerMin ?? 0) * maxMinutes;
  return nextSleeveCost <= reach ? nextSleeveCost : 0;
}

/** A corporate faction's invite in progress: company rep at its employer against what the invite needs. */
export type CompanyTarget = { faction: string; company: string; rep: number; needed: number };

/** The company rep an invite needs, from getFactionInviteRequirements; undefined when it has no such requirement. */
export function companyRepRequirement(requirements: PlayerRequirement[]): { company: string; reputation: number } | undefined {
  for (const req of requirements) {
    if (req.type === "companyReputation") return { company: req.company, reputation: req.reputation };
  }
  return undefined;
}

/**
 * Corporate factions to work toward, nearest invite first: not joined,
 * selling a useful augmentation not owned yet, and still short of the
 * company rep their invite needs. Each one, once joined, becomes a faction
 * rep target - another place a sleeve can earn rep (one sleeve per
 * faction, so more factions means more sleeves on rep).
 */
export function companyTargets(candidates: CompanyTarget[]): CompanyTarget[] {
  return candidates.filter((c) => c.rep < c.needed).sort((a, b) => a.needed - a.rep - (b.needed - b.rep));
}

/**
 * Whether an invite is still blocked on combat stats: an unmet requirement
 * (top level or everyCondition, as collectUnsatisfiedActionable reads
 * them) asks for more of a combat stat than the player has. Combat
 * augmentations only earn their place while some wanted invite is - BN10
 * kept saving $12.5T for Hydroflame Left Arm after joining Daedalus and The
 * Covenant, the invites combat was added for. Only while the combat route
 * is realistic, though: every combat stat it asks for already at least
 * `minProgress` of the way there. BN12's install loop bought combat
 * augmentations for Illuminati's 1200s with every combat stat under 10 -
 * useless, and each raised the price of the hacking ones after it.
 */
export const COMBAT_ROUTE_MIN_PROGRESS = 0.5;

export function combatBlocksInvite(requirements: PlayerRequirement[], snapshot: EligibilitySnapshot, minProgress = COMBAT_ROUTE_MIN_PROGRESS): boolean {
  return collectUnsatisfiedActionable(requirements, snapshot).some((req) => {
    const gaps = combatSkillGaps(req, snapshot);
    if (gaps.length === 0 || req.type !== "skills") return false;
    return gaps.every(({ stat }) => snapshot.skills[stat] >= minProgress * ((req.skills as Record<string, number>)[stat] ?? 0));
  });
}

/**
 * An invite's unmet requirements as short text, for tools/status.js
 * (top level and everyCondition flattened; a someCondition shows as
 * "one of (...)"). numAugmentations uses `installedAugs`; types this file
 * can't check from the snapshot (backdoors, Source-Files, ...) are listed
 * as-is with "(unchecked)".
 */
export function describeUnmetRequirements(requirements: PlayerRequirement[], snapshot: EligibilitySnapshot, installedAugs: number): string[] {
  const fmt = (n: number): string => (n >= 1e9 ? `$${(n / 1e9).toFixed(0)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${n.toFixed(0)}`);
  const out: string[] = [];
  const describe = (req: PlayerRequirement): string | undefined => {
    switch (req.type) {
      case "everyCondition":
        req.conditions.forEach((c) => {
          const text = describe(c);
          if (text) out.push(text);
        });
        return undefined;
      case "someCondition": {
        if (evaluateRequirement(req, snapshot)) return undefined;
        const options = req.conditions.map((c) => describeOne(c)).filter((t): t is string => !!t);
        return options.length > 0 ? `one of (${options.join(" | ")})` : undefined;
      }
      default:
        return describeOne(req);
    }
  };
  const describeOne = (req: PlayerRequirement): string | undefined => {
    switch (req.type) {
      case "numAugmentations":
        return installedAugs >= req.numAugmentations ? undefined : `${req.numAugmentations} installed augs (have ${installedAugs})`;
      case "money":
        return evaluateRequirement(req, snapshot) ? undefined : `${fmt(req.money)} cash (have ${fmt(snapshot.money)})`;
      case "skills": {
        const gaps = Object.entries(req.skills)
          .map(([stat, level]) => ({ stat, level: level ?? 0, have: snapshot.skills[stat as keyof EligibilitySnapshot["skills"]] ?? 0 }))
          .filter((g) => g.have < g.level)
          .map((g) => `${g.stat} ${g.level} (have ${g.have})`);
        return gaps.length > 0 ? gaps.join(", ") : undefined;
      }
      case "karma":
        return evaluateRequirement(req, snapshot) ? undefined : `karma ${req.karma} (have ${snapshot.karma.toFixed(0)})`;
      case "companyReputation":
        return evaluateRequirement(req, snapshot) ? undefined : `${req.reputation} rep at ${req.company}`;
      case "employedBy":
      case "city":
      case "numPeopleKilled":
      case "not":
        return evaluateRequirement(req, snapshot) ? undefined : JSON.stringify(req);
      case "backdoorInstalled":
        return `backdoor on ${req.server} (unchecked)`;
      default:
        return `${req.type} (unchecked)`;
    }
  };
  for (const req of requirements) {
    const text = describe(req);
    if (text) out.push(text);
  }
  return out;
}

/**
 * Whether the player's work slot goes to the gang's karma crime (GANG).
 * Sleeves earn karma either way; the player joins them when the phase says
 * so, when there are no sleeves, or once donations are open - favor work
 * has nothing left to do then and karma is the only critical path left.
 * Sleeves earn next to nothing for their first hours (shock scales their
 * exp to ~0, so they train first): a simulation by the game's formulas put
 * a sleeves-only gang near 11 h, against 7.95 h in BN12's third run with
 * the player on the crime for its first 4.85 h.
 */
export function playerChasesKarma(phaseSaysSo: boolean, sleeves: boolean, donationsOpen: boolean): boolean {
  return phaseSaysSo || !sleeves || donationsOpen;
}

/**
 * Augmentation stats boosting the Hacknet. Useful only where hashes are the
 * income (BitNode 9): Netburners' five together multiply hash production by
 * 2.53 there, but BN10 spent rep and money on them for nothing.
 */
export const HACKNET_STATS = ["hacknet_node_money", "hacknet_node_purchase_cost", "hacknet_node_ram_cost", "hacknet_node_core_cost", "hacknet_node_level_cost"];

/**
 * What augmentations are worth, as tiers bought in order (tieredFocus): the
 * BitNode's economy first. Where hashes are the income, Hacknet production
 * leads - ahead of the hacking focus, which the finish still needs; elsewhere
 * just the configured focus.
 */
export function focusTiers(focus: string[], hashIncome: boolean): string[][] {
  return hashIncome ? [["hacknet_node_money"], focus] : [focus];
}

/** priorityFocus over `tiers` in order: the first tier with anything reachable decides. */
export function tieredFocus(
  catalog: AugmentationInfo[],
  reps: Record<string, number>,
  owned: string[],
  donatable: Set<string>,
  tiers: string[][],
  maxPrice = Infinity,
  cheapest = false
): AugmentationInfo | undefined {
  for (const tier of tiers) {
    const pick = priorityFocus(catalog, reps, owned, donatable, tier, maxPrice, cheapest);
    if (pick) return pick;
  }
  return undefined;
}

// Pending Hacknet production boost worth an install where hashes are the
// income (hacknetInstallPays): an install wipes the Hacknet, which then
// rebuilds at this many times the rate.
export const HACKNET_INSTALL_MIN_BOOST = 2;

/**
 * Whether installing now pays for the Hacknet where hashes are the income:
 * pending augmentations multiply its production by HACKNET_INSTALL_MIN_BOOST
 * or more. The install wipes the servers, but the payback policy rebuilds
 * them, at that multiple for the rest of the BitNode.
 */
export function hacknetInstallPays(hashIncome: boolean, pendingHacknetMult: number | undefined): boolean {
  return hashIncome && (pendingHacknetMult ?? 1) >= HACKNET_INSTALL_MIN_BOOST;
}
