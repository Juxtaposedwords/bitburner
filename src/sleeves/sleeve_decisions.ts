/**
 * Pure logic for sleeve_daemon.ts - no `ns` dependency.
 *
 * Sleeves (Source-File 10, or inside BitNode 10) are extra workers running
 * alongside the player. What makes them valuable: a sleeve's crimes lower
 * the *player's* karma, the experience it earns is shared with the player
 * (scaled by its shock and sync), and it can do faction work - alongside the
 * player at the same faction (checked live with tools/sleeve_probe.js: the
 * game allowed it and kept the player working), but only one sleeve per
 * faction.
 *
 * Each sleeve gets one goal per tick, in priority order:
 * 1. Gang karma - while karma still blocks creating a gang (Approach.GANG),
 *    the crime that lowers karma fastest for *that* sleeve's stats.
 * 2. Recovery - shock recovery down to maxShock, then synchronize up to
 *    minSync, so the sleeve's later work pays off fully for the player.
 * 3. Faction rep - work at a joined faction still short of a rep target
 *    (faction_daemon.ts's repTargets), one sleeve per faction (the game
 *    refuses two sleeves at one faction; a sleeve may join the player's).
 *    The player's faction first, so its favor target finishes sooner with
 *    two workers; then the closest target.
 * 4. Company work toward a corporate faction's invite (companies), one
 *    sleeve per company - each invite becomes another rep target.
 * 5. Training for the player's share of the exp (trainingFor): gym for a
 *    wanted invite's combat stat, else a class. Re-decided every tick, so
 *    a new rep target takes a training sleeve back to faction work.
 * 6. Otherwise, the crime earning the most money.
 */

import { trainingPaysOff } from "factions/faction_decisions";

export type SleeveGoal =
  | { kind: "karmaCrime"; crime: string }
  | { kind: "moneyCrime"; crime: string }
  | { kind: "recovery" }
  | { kind: "sync" }
  | { kind: "faction"; faction: string }
  // Company work toward a corporate faction's invite (companyTargets).
  | { kind: "company"; company: string }
  // Gym training: for the karma crime's success chance (sleeveTrainingPaysOff),
  // or, with no rep left to earn, for the player's share of the exp toward a
  // wanted invite's combat stat. `stat` is a GymType value ("str", ...).
  | { kind: "gym"; stat: string; gym: string; purpose?: "karma" | "invite" }
  // A university class with no rep left to earn: the player gets a share of
  // the sleeve's exp (hacking, with Algorithms).
  | { kind: "study"; course: string; university: string }
  | { kind: "idle" };

export type SleeveState = { index: number; shock: number; sync: number };

export type SleeveContext = {
  // The best karma crime for sleeve `index`, when karma still blocks a gang; undefined otherwise.
  karmaCrimeFor: (index: number) => string | undefined;
  // In the karma phase: whether sleeve `index` should synchronize first
  // (syncPaysOff, or measuring its sync rate). Absent = never.
  syncFirstFor?: (index: number) => boolean;
  // In the karma phase: a gym stint that gets sleeve `index` more karma
  // before the gang requirement is met than crime now would. Absent = never.
  karmaTrainingFor?: (index: number) => { stat: string; gym: string } | undefined;
  // Companies to earn rep at for a corporate faction's invite, nearest
  // first (faction_daemon.ts's companyTargets). One sleeve per company.
  companies?: string[];
  // Once every rep target has a worker: training that helps the player
  // (gym for an invite's stat, else a class), or undefined (e.g. cash too
  // low) for a money crime. Absent = money crime.
  trainingFor?: (index: number) => SleeveGoal | undefined;
  moneyCrimeFor: (index: number) => string | undefined;
  // Joined factions still short of a rep target, with the rep left to earn.
  repGaps: Record<string, number>;
  // The faction the player is working for - the first sleeve joins it while it's short of its target.
  playerFaction?: string;
  maxShock: number;
  minSync: number;
};

/** One goal per sleeve, in index order (see the module doc for the priorities). */
export function decideSleeveGoals(sleeves: SleeveState[], ctx: SleeveContext): SleeveGoal[] {
  const openFactions = Object.entries(ctx.repGaps)
    .filter(([, gap]) => gap > 0)
    .sort((a, b) => (a[0] === ctx.playerFaction ? -1 : b[0] === ctx.playerFaction ? 1 : a[1] - b[1]))
    .map(([faction]) => faction);

  const openCompanies = [...(ctx.companies ?? [])];

  return sleeves.map((sleeve): SleeveGoal => {
    const karmaCrime = ctx.karmaCrimeFor(sleeve.index);
    if (karmaCrime) {
      if (ctx.syncFirstFor?.(sleeve.index)) return { kind: "sync" };
      const training = ctx.karmaTrainingFor?.(sleeve.index);
      return training ? { kind: "gym", ...training, purpose: "karma" } : { kind: "karmaCrime", crime: karmaCrime };
    }
    if (sleeve.shock > ctx.maxShock) return { kind: "recovery" };
    if (sleeve.sync < ctx.minSync) return { kind: "sync" };
    const faction = openFactions.shift();
    if (faction) return { kind: "faction", faction };
    const company = openCompanies.shift();
    if (company) return { kind: "company", company };
    const training = ctx.trainingFor?.(sleeve.index);
    if (training) return training;
    const moneyCrime = ctx.moneyCrimeFor(sleeve.index);
    return moneyCrime ? { kind: "moneyCrime", crime: moneyCrime } : { kind: "idle" };
  });
}

/** The fields of ns.sleeve.getTask() compared here. */
export type SleeveTaskInfo = {
  type: string;
  crimeType?: string;
  factionName?: string;
  companyName?: string;
  classType?: string;
  location?: string;
} | null;

/** Whether `task` already carries out `goal` - so an unchanged goal never restarts the sleeve's work. */
export function taskMatchesGoal(task: SleeveTaskInfo, goal: SleeveGoal): boolean {
  switch (goal.kind) {
    case "karmaCrime":
    case "moneyCrime":
      return task?.type === "CRIME" && task.crimeType === goal.crime;
    case "recovery":
      return task?.type === "RECOVERY";
    case "sync":
      return task?.type === "SYNCHRO";
    case "faction":
      return task?.type === "FACTION" && task.factionName === goal.faction;
    case "company":
      return task?.type === "COMPANY" && task.companyName === goal.company;
    case "gym":
      return task?.type === "CLASS" && task.classType === goal.stat && task.location === goal.gym;
    case "study":
      return task?.type === "CLASS" && task.classType === goal.course && task.location === goal.university;
    case "idle":
      return task === null;
  }
}

/**
 * The crime maximizing `value` per second: value per success x success
 * chance / time - karma for the gang, money otherwise. undefined when
 * nothing can succeed.
 */
export function bestCrimeBy(candidates: { crime: string; value: number; timeMs: number; successChance: number }[]): string | undefined {
  const rate = (c: (typeof candidates)[number]): number => (c.timeMs > 0 ? (c.value * c.successChance) / c.timeMs : 0);
  const viable = candidates.filter((c) => rate(c) > 0);
  if (viable.length === 0) return undefined;
  return viable.reduce((best, c) => (rate(c) > rate(best) ? c : best)).crime;
}

/**
 * Whether synchronizing a sleeve to 100 first reaches the gang karma
 * requirement sooner than keeping it on crime. A sleeve's crime karma is
 * scaled by its sync (as far as the game's code goes: karma x sync / 100),
 * so a low-sync sleeve adds little - BN10's one sleeve at sync 25 barely
 * moved the rate. Karma rates are per ms: `playerRate` is the player's own
 * crime (which keeps going while the sleeve syncs), `sleeveRateAtFull` the
 * sleeve's at sync 100. `syncPerMin` is measured by sleeve_daemon.ts.
 */
export function syncPaysOff(remainingKarma: number, playerRate: number, sleeveRateAtFull: number, sync: number, syncPerMin: number): boolean {
  if (sync >= 100 || !(syncPerMin > 0) || !(remainingKarma > 0)) return false;
  const rateNow = playerRate + (sleeveRateAtFull * sync) / 100;
  const rateFull = playerRate + sleeveRateAtFull;
  if (!(rateFull > 0)) return false;
  const syncMs = ((100 - sync) / syncPerMin) * 60_000;
  const leftAfterSync = Math.max(0, remainingKarma - playerRate * syncMs);
  const keepGoing = rateNow > 0 ? remainingKarma / rateNow : Infinity;
  return syncMs + leftAfterSync / rateFull < keepGoing;
}

/**
 * Updates a sleeve's measured sync rate (sync points per minute) from two
 * readings at least `minGapMs` apart taken while it was synchronizing;
 * blends with an earlier estimate. Returns the (possibly unchanged) rate.
 */
export function updateSyncRate(
  previous: { sync: number; t: number; syncing: boolean } | undefined,
  current: { sync: number; t: number; syncing: boolean },
  rate: number | undefined,
  minGapMs = 60_000
): number | undefined {
  if (!previous || !previous.syncing || !current.syncing || current.t - previous.t < minGapMs || current.sync <= previous.sync) return rate;
  const measured = (current.sync - previous.sync) / ((current.t - previous.t) / 60_000);
  return rate === undefined ? measured : (rate + measured) / 2;
}

/** Per-sleeve memory kept across restarts in SLEEVE_STATE_PATH. */
export const SLEEVE_STATE_PATH = "/var/sleeve_state.txt";
export type SleeveMemory = { syncPerMin?: number; last?: { sync: number; t: number; syncing: boolean } };

/** Sleeves exist inside BitNode 10 or with Source-File 10. */
export function sleevesAvailable(node: number | undefined, sourceFiles: Record<string, number> | undefined): boolean {
  return node === 10 || (sourceFiles?.["10"] ?? 0) >= 1;
}

/** Written by sleeve_daemon.ts every tick: what each sleeve is doing. */
export const SLEEVES_PATH = "/var/sleeves.txt";
export type SleevesFile = {
  sleeves: { index: number; shock: number; sync: number; goal: string; syncPerMin?: number; memory?: number; augs?: number }[];
  // BitNode 10: the next sleeve's price at The Covenant, and the game's
  // latest answer to buying one (it names what's missing).
  shop?: { nextSleeveCost: number; lastMessage?: string };
  writtenAt: number;
};

/** A goal as one short string, for logs and SLEEVES_PATH. */
export function describeGoal(goal: SleeveGoal): string {
  switch (goal.kind) {
    case "karmaCrime":
      return `crime for karma: ${goal.crime}`;
    case "moneyCrime":
      return `crime for money: ${goal.crime}`;
    case "company":
      return `company work: ${goal.company}`;
    case "gym":
      return `gym for ${goal.purpose ?? "karma"}: ${goal.stat} at ${goal.gym}`;
    case "study":
      return `study for the player: ${goal.course} at ${goal.university}`;
    case "faction":
      return `faction work: ${goal.faction}`;
    default:
      return goal.kind;
  }
}

export const COVENANT = "The Covenant";

/**
 * What to spend on sleeves this tick - BitNode 10 only, where The Covenant
 * sells extra sleeves (ns.sleeve.purchaseSleeve) and sleeves' memory can be
 * upgraded (ns.sleeve.upgradeMemory: a sleeve keeps that much sync through
 * an install instead of restarting at 0).
 *
 * Both last beyond BitNode 10 (confirmed in the game's source): memory is
 * never reset, and the sleeve count is min(3, SF10 level + (1 in BN10)) +
 * sleevesFromCovenant - finishing BN10 turns its free sleeve into SF10's,
 * so every sleeve and its memory carries over. A sleeve costs $10T x 10^n
 * (n = sleeves bought so far, at most 5) and needs only membership and
 * cash - no rep.
 *
 * `budget` is cash available for it (above the shared savings target,
 * times the spend fraction). A new sleeve comes first - another worker on
 * the grind and another share of exp for the player - when its cost fits;
 * only Covenant members can buy one. Then one memory upgrade for the sleeve
 * with the least memory, when that fits in what's left.
 */
export type SleeveInvestment = { buySleeve: boolean; memoryFor?: number };

export function decideSleeveInvestment(
  node: number | undefined,
  covenantMember: boolean,
  budget: number,
  sleeveCost: number,
  memory: { index: number; memory: number; upgradeCost: number }[]
): SleeveInvestment {
  if (node !== 10) return { buySleeve: false };
  const buySleeve = covenantMember && Number.isFinite(sleeveCost) && sleeveCost <= budget;
  const left = buySleeve ? budget - sleeveCost : budget;
  const upgradable = memory.filter((m) => m.memory < 100 && Number.isFinite(m.upgradeCost) && m.upgradeCost <= left);
  const lowest = upgradable.length > 0 ? upgradable.reduce((a, b) => (b.memory < a.memory ? b : a)) : undefined;
  return { buySleeve, memoryFor: lowest?.index };
}

/**
 * Whether a sleeve should train before its karma crime: over `horizonMs`
 * (the time until the gang karma requirement is met at today's total
 * rate), crime at `chanceAfter` after `trainMs` at the gym earns more
 * karma than crime at `chanceNow` all along. trainingPaysOff (the player's
 * rule) with the sleeve's own share of the remaining karma. Sleeves start
 * each BitNode with reset stats - BN10's second run had five on Homicide
 * at low success, ~11.6h to go.
 */
export function sleeveTrainingPaysOff(
  horizonMs: number,
  karmaPerSuccess: number,
  crimeTimeMs: number,
  chanceNow: number,
  chanceAfter: number,
  trainMs: number
): boolean {
  if (!(horizonMs > 0) || !Number.isFinite(horizonMs)) return false;
  const shareNow = ((karmaPerSuccess * chanceNow) / crimeTimeMs) * horizonMs;
  return trainingPaysOff(shareNow > 0 ? shareNow : karmaPerSuccess, karmaPerSuccess, crimeTimeMs, chanceNow, chanceAfter, trainMs);
}

/**
 * Multiplier keys that help what sleeves do: faction work (hacking
 * contracts, field and security work), crimes, training, and the exp the
 * player shares. Hacknet, Bladeburner and the like don't.
 */
export const SLEEVE_USEFUL_STATS = [
  "hacking",
  "strength",
  "defense",
  "dexterity",
  "agility",
  "charisma",
  "hacking_exp",
  "strength_exp",
  "defense_exp",
  "dexterity_exp",
  "agility_exp",
  "charisma_exp",
  "faction_rep",
  "crime_success",
  "crime_money",
  "work_money",
];

export type SleeveAugOption = { index: number; name: string; cost: number; stats: Record<string, number>; shock: number };

/**
 * The next sleeve augmentation to buy: the cheapest one that raises a
 * SLEEVE_USEFUL_STATS multiplier and fits `budget`, for a sleeve with no
 * shock (the game requires it). Installs keep sleeve augmentations - only
 * a new BitNode clears them - so they're worth buying any time; each
 * purchase resets that sleeve's exp, which comes back quickly.
 */
export function pickSleeveAug(options: SleeveAugOption[], budget: number): SleeveAugOption | undefined {
  const useful = options.filter(
    (o) => o.shock <= 0 && o.cost <= budget && SLEEVE_USEFUL_STATS.some((key) => (o.stats[key] ?? 1) > 1)
  );
  return useful.length === 0 ? undefined : useful.reduce((a, b) => (b.cost < a.cost ? b : a));
}

export type SleeveConfig = {
  enabled: boolean;
  maxShock: number;
  minSync: number;
  // BitNode 10: fraction of cash above the shared savings target spent on
  // new sleeves and memory upgrades (decideSleeveInvestment).
  investSpendFraction: number;
};

export const DEFAULT_CONFIG: SleeveConfig = { enabled: true, maxShock: 0, minSync: 100, investSpendFraction: 0.5 };
export const CONFIG_PATH = "/etc/sleeve.txt";

/** What sleeve_shop.ts last saw and did: next Covenant sleeve's price, the game's last refusal, augmentations per sleeve. */
export const SLEEVE_SHOP_PATH = "/var/sleeve_shop.txt";
export type SleeveShopFile = { nextSleeveCost?: number; lastMessage?: string; augs: number[]; writtenAt: number };
