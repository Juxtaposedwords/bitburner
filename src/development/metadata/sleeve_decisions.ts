/**
 * Pure logic for sleeve_daemon.ts - no `ns` dependency.
 *
 * Sleeves (Source-File 10, or inside BitNode 10) are extra workers running
 * alongside the player. What makes them valuable: a sleeve's crimes lower
 * the *player's* karma, the experience it earns is shared with the player
 * (scaled by its shock and sync), and it can do faction work - one worker per
 * faction, so it earns rep at a different faction than the player.
 *
 * Each sleeve gets one goal per tick, in priority order:
 * 1. Gang karma - while karma still blocks creating a gang (Approach.GANG),
 *    the crime that lowers karma fastest for *that* sleeve's stats.
 * 2. Recovery - shock recovery down to maxShock, then synchronize up to
 *    minSync, so the sleeve's later work pays off fully for the player.
 * 3. Faction rep - work at a joined faction still short of a rep target
 *    (faction_daemon.ts's repTargets), one sleeve per faction and never the
 *    player's own faction; the closest target first.
 * 4. Otherwise, the crime earning the most money.
 */

export type SleeveGoal =
  | { kind: "karmaCrime"; crime: string }
  | { kind: "moneyCrime"; crime: string }
  | { kind: "recovery" }
  | { kind: "sync" }
  | { kind: "faction"; faction: string }
  | { kind: "idle" };

export type SleeveState = { index: number; shock: number; sync: number };

export type SleeveContext = {
  // The best karma crime for sleeve `index`, when karma still blocks a gang; undefined otherwise.
  karmaCrimeFor: (index: number) => string | undefined;
  // In the karma phase: whether sleeve `index` should synchronize first
  // (syncPaysOff, or measuring its sync rate). Absent = never.
  syncFirstFor?: (index: number) => boolean;
  moneyCrimeFor: (index: number) => string | undefined;
  // Joined factions still short of a rep target, with the rep left to earn.
  repGaps: Record<string, number>;
  // The faction the player is working for, which a sleeve can't also work for.
  playerFaction?: string;
  maxShock: number;
  minSync: number;
};

/** One goal per sleeve, in index order (see the module doc for the priorities). */
export function decideSleeveGoals(sleeves: SleeveState[], ctx: SleeveContext): SleeveGoal[] {
  const openFactions = Object.entries(ctx.repGaps)
    .filter(([faction, gap]) => gap > 0 && faction !== ctx.playerFaction)
    .sort((a, b) => a[1] - b[1])
    .map(([faction]) => faction);

  return sleeves.map((sleeve): SleeveGoal => {
    const karmaCrime = ctx.karmaCrimeFor(sleeve.index);
    if (karmaCrime) return ctx.syncFirstFor?.(sleeve.index) ? { kind: "sync" } : { kind: "karmaCrime", crime: karmaCrime };
    if (sleeve.shock > ctx.maxShock) return { kind: "recovery" };
    if (sleeve.sync < ctx.minSync) return { kind: "sync" };
    const faction = openFactions.shift();
    if (faction) return { kind: "faction", faction };
    const moneyCrime = ctx.moneyCrimeFor(sleeve.index);
    return moneyCrime ? { kind: "moneyCrime", crime: moneyCrime } : { kind: "idle" };
  });
}

/** The fields of ns.sleeve.getTask() compared here. */
export type SleeveTaskInfo = { type: string; crimeType?: string; factionName?: string } | null;

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
  sleeves: { index: number; shock: number; sync: number; goal: string; syncPerMin?: number }[];
  writtenAt: number;
};

/** A goal as one short string, for logs and SLEEVES_PATH. */
export function describeGoal(goal: SleeveGoal): string {
  switch (goal.kind) {
    case "karmaCrime":
      return `crime for karma: ${goal.crime}`;
    case "moneyCrime":
      return `crime for money: ${goal.crime}`;
    case "faction":
      return `faction work: ${goal.faction}`;
    default:
      return goal.kind;
  }
}
