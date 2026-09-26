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

/** The fields of ns.singularity.getCurrentWork() this module reads. */
export type CurrentWork = { type: string; location?: string; classType?: string } | null;

export type StudyStep =
  | { kind: "idle" }
  | { kind: "studying" }
  | { kind: "travel"; city: string }
  | { kind: "enroll" }
  | { kind: "unknownUniversity" };

/**
 * What to do this tick. `active` is whether the scheduler approach is
 * GROW_STATS. Never re-enrolls in the class already in progress (restarting
 * work resets it and snaps the UI, same as faction_daemon.ts's
 * isAlreadyWorking), and travels first when the university is elsewhere.
 * Leaving GROW_STATS does nothing here - faction_daemon.ts takes the work
 * slot back on its next tick.
 */
export function decideStudyStep(active: boolean, university: string, course: string, playerCity: string, current: CurrentWork): StudyStep {
  if (!active) return { kind: "idle" };
  const city = UNIVERSITY_CITY[university];
  if (!city) return { kind: "unknownUniversity" };
  if (current?.type === "CLASS" && current.location === university && current.classType === course) return { kind: "studying" };
  if (playerCity !== city) return { kind: "travel", city };
  return { kind: "enroll" };
}
