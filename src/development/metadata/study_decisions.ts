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
 * Written by study_daemon.ts every tick, read by hacknet_daemon.ts to put
 * the hash upgrade that boosts the current activity first (see
 * hacknet_decisions.ts's prioritizeForActivity). "none" outside GROW_STATS.
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
