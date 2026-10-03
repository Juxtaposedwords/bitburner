/**
 * Pure logic for study_daemon.ts - no `ns` dependency.
 *
 * University classes are hacking experience that BN9 doesn't nerf
 * (HackExpGain 0.05 applies to scripts only), and the "Improve Studying"
 * hash upgrade multiplies it - but only while the player is actually in a
 * class. Universities exist in only these three cities (a game fact, same as
 * faction_decisions.ts's COMPANY_FACTION_EMPLOYER).
 */
export const UNIVERSITY_CITY: Record<string, string> = {
  "Rothman University": "Sector-12",
  "Summit University": "Aevum",
  "ZB Institute of Technology": "Volhaven",
};

export type StudyConfig = { university: string; course: string };

// The highest-experience university and course. Both cost money per second,
// which gang income covers easily. Here rather than in study_daemon.ts so
// tools/skill_eta.ts can read the same config without importing the daemon.
export const DEFAULT_CONFIG: StudyConfig = { university: "ZB Institute of Technology", course: "Algorithms" };
export const CONFIG_PATH = "/etc/study.txt";

/** Gyms, by city - same kind of game fact as UNIVERSITY_CITY. */
export const GYM_CITY: Record<string, string> = {
  "Iron Gym": "Sector-12",
  "Powerhouse Gym": "Sector-12",
  "Crush Fitness Gym": "Aevum",
  "Snap Fitness Gym": "Aevum",
  "Millenium Fitness Gym": "Volhaven",
};

/**
 * Written by study_daemon.ts every tick, read by hacknet_daemon.ts: a class
 * or gym session toward a blocked goal gets that training hash upgrade
 * (chooseHashUpgrade). "none" when not training.
 */
export const ACTIVITY_PATH = "/var/study_activity.txt";
export type ActivityFile = { kind: "class" | "gym" | "none"; writtenAt: number };

/** The fields of ns.singularity.getCurrentWork() this module reads. */
export type CurrentWork = { type: string; location?: string; classType?: string } | null;

/**
 * One thing to be doing: a university course (`detail` is the course) or a
 * gym workout (`detail` is the GymType, e.g. "str"). Both show up in
 * getCurrentWork() as type CLASS with that location and classType.
 */
export type Activity = { kind: "class" | "gym"; location: string; detail: string; stat?: string };

export type StudyStep =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "travel"; city: string }
  | { kind: "start" }
  | { kind: "unknownLocation" };

/**
 * What to do this tick. `active` is whether the scheduler approach is
 * GROW_STATS. Never restarts the activity already in progress (restarting
 * work resets it and snaps the UI, same as faction_daemon.ts's
 * isAlreadyWorking), and travels first when the location is elsewhere.
 * Leaving GROW_STATS does nothing here - faction_daemon.ts takes the work
 * slot back on its next tick.
 */
export function decideStudyStep(active: boolean, activity: Activity, playerCity: string, current: CurrentWork): StudyStep {
  if (!active) return { kind: "idle" };
  const city = (activity.kind === "class" ? UNIVERSITY_CITY : GYM_CITY)[activity.location];
  if (!city) return { kind: "unknownLocation" };
  if (current?.type === "CLASS" && current.location === activity.location && current.classType === activity.detail) return { kind: "busy" };
  if (playerCity !== city) return { kind: "travel", city };
  return { kind: "start" };
}

/**
 * Whether paid training (a class or gym workout, both charged per second)
 * can be afforded: cash covers `runwayMinutes` of it. `costPerMin` comes
 * from ns.formulas.work.universityGains/gymGains (their `money` is negative
 * - a cost - per 200ms cycle); without Formulas.exe it's unknown, and
 * `fallbackMinCash` decides instead. Free training is always affordable.
 * Nothing checked this before: the first boot of BN10 (starting cash
 * ~$1,000, scheduler setting still GROW_STATS) went straight into ZB's
 * Algorithms class and ran money negative.
 */
export function canAffordTraining(money: number, costPerMin: number | undefined, runwayMinutes: number, fallbackMinCash: number): boolean {
  if (costPerMin === undefined) return money >= fallbackMinCash;
  return costPerMin <= 0 || money >= costPerMin * runwayMinutes;
}

/** Cost per minute from a WorkStats-style per-cycle `money` (negative = cost). */
export function trainingCostPerMin(perCycleMoney: number, cyclesPerMin: number): number {
  return Math.max(0, -perCycleMoney) * cyclesPerMin;
}

/** Minutes of gym time one combat stat still needs (0 once there), with the gym that gets it there fastest. */
export type CombatNeed = { stat: string; gymType: string; gym: string; minutes: number };

/**
 * Which Daedalus route to train for: its invite takes hacking 2500 OR 1500
 * in every combat stat. Combat stats train one at a time, so that route's
 * time is the sum. Whichever finishes sooner wins; while it's combat, the
 * first unfinished stat (fixed order, so it sticks with one until done).
 * `combatRouteOpen` is false once it no longer matters - Daedalus already
 * joined, or w0r1d_d43m0n visible - and studying is all that's left.
 */
export function chooseTraining(hackingMinutes: number, combat: CombatNeed[], combatRouteOpen: boolean): CombatNeed | undefined {
  if (!combatRouteOpen) return undefined;
  const unfinished = combat.filter((c) => c.minutes > 0);
  if (unfinished.length === 0) return undefined;
  const combatMinutes = unfinished.reduce((sum, c) => sum + c.minutes, 0);
  return combatMinutes < hackingMinutes ? unfinished[0] : undefined;
}

/**
 * Programs the player can write (ns.singularity.createProgram): hacking
 * level needed, and the darkweb price that makes buying the alternative.
 * Port openers in order, then Formulas.exe.
 */
export const CREATABLE_PROGRAMS: { name: string; level: number; cost: number }[] = [
  { name: "BruteSSH.exe", level: 50, cost: 500e3 },
  { name: "FTPCrack.exe", level: 100, cost: 1.5e6 },
  { name: "relaySMTP.exe", level: 250, cost: 5e6 },
  { name: "HTTPWorm.exe", level: 500, cost: 30e6 },
  { name: "SQLInject.exe", level: 750, cost: 250e6 },
  { name: "Formulas.exe", level: 1000, cost: 5e9 },
];

/**
 * The program to write with a free work slot: the first one not owned
 * whose hacking level is met and that cash can't simply buy (the program
 * shopper buys those). Writing costs only time - right after an install,
 * with programs gone and cash near zero, it's how port openers come back
 * (BN10's second run sat with BruteSSH/FTPCrack unbought at $144K).
 */
export function pickProgramToCreate(owned: (name: string) => boolean, hackingLevel: number, money: number): string | undefined {
  return CREATABLE_PROGRAMS.find((p) => !owned(p.name) && hackingLevel >= p.level && money < p.cost)?.name;
}
