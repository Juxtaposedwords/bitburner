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

export const NEUROFLUX_GOVERNOR = "NeuroFlux Governor";
// Installing it reveals w0r1d_d43m0n - the BitNode's finish line.
export const RED_PILL = "The Red Pill";

/**
 * Written by faction_daemon.ts every tick: every joined faction's current
 * rep, plus which one it's working for. monitoring_daemon.ts turns it into
 * gauge/rep_<faction> series (see repSeriesId) - reading rep directly would
 * put ns.singularity's RAM cost on the sampler.
 */
export const FACTION_REPS_PATH = "/var/faction_reps.txt";
export type FactionRepsFile = {
  reps: Record<string, number>;
  workTarget?: string;
  workType?: string;
  // Rep/min for each work type the work target offers, by formula (see
  // bestWorkType) - `cat` the file to compare field work vs hacking contracts.
  workGains?: Record<string, number>;
  writtenAt: number;
};

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
 */
export function decideWorkTarget(
  joinedFactions: string[],
  reps: Record<string, number>,
  catalog: AugmentationInfo[],
  owned: string[]
): string | undefined {
  const ownedSet = new Set(owned);

  const redPill = catalog.find(
    (aug) => aug.name === RED_PILL && joinedFactions.includes(aug.faction) && !ownedSet.has(aug.name) && (reps[aug.faction] ?? 0) < aug.repReq
  );
  if (redPill) return redPill.faction;

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
export function decideInstallReady(purchaseDecision: PurchaseDecision, pendingAugmentations: string[], reserveMoney: number): boolean {
  return reserveMoney <= 0 && purchaseDecision.kind === "none" && pendingAugmentations.length > 0;
}

/**
 * The last steps before an install, once decideInstallReady is true.
 * An install resets cash to $1,000 and deletes every stock position with no
 * refund (see development/libraries/install_handshake.ts), so anything
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

/** Trivial mirror of gang_decisions.ts's decideStandDown - bounds crime-for-kills grinding via /var/faction_state.txt's crimeAttempts. */
export function decideEligibilityStandDown(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/** Once any one city faction is joined, the whole category stops (see faction_daemon.ts's pursueCityFactions doc for why). */
export function hasAnyCityFaction(joinedFactions: string[]): boolean {
  return CITY_FACTION_NAMES.some((faction) => joinedFactions.includes(faction));
}
