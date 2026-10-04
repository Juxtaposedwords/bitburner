/**
 * Pure skill-level math shared by tools/skill_eta.ts and faction_daemon.ts -
 * no `ns` dependency; the game's own formulas are passed in.
 *
 * A skill level comes from experience through a log curve scaled by the
 * skill's total multiplier (augmentations x the BitNode's level multiplier),
 * so experience needed grows exponentially with level, and the multiplier
 * sits inside that exponent: in BN9 at x5.3, +10% multiplier cuts the
 * experience for hacking 2500 by ~4x, while +10% experience rate saves 10%.
 * That asymmetry is what the install comparison below is about.
 */

/**
 * Written by faction_daemon.ts every tick: the combined multipliers of the
 * purchased-but-uninstalled augmentations. Reading them directly takes
 * ns.singularity.getOwnedAugmentations + getAugmentationStats (~11 GB), which
 * made tools/skill_eta.js too big to run beside the daemons on home.
 */
export const PENDING_BOOST_PATH = "/var/pending_augmentations.txt";
export type PendingBoost = { count: number; multipliers: Record<string, number>; writtenAt: number };

/** Daedalus (which sells The Red Pill) invites at hacking 2500, or at 1500 in every combat stat. */
export const DAEDALUS_HACKING_LEVEL = 2500;
export const DAEDALUS_COMBAT_LEVEL = 1500;
export const COMBAT_SKILLS = ["strength", "defense", "dexterity", "agility"] as const;

/**
 * Hacking level to work toward. An explicit `configured` level wins;
 * otherwise w0r1d_d43m0n's requirement once that server exists (after The
 * Red Pill is installed), else Daedalus's.
 */
export function hackingGoal(configured: number, worldDaemonRequired: number | undefined): number {
  if (configured > 0) return configured;
  return worldDaemonRequired ?? DAEDALUS_HACKING_LEVEL;
}

/**
 * The multiplier m at which skillAt(m) == level, where skillAt is
 * non-decreasing and floors to whole levels (ns.formulas.skills.
 * calculateSkill(currentExp, m)): the midpoint between the smallest m
 * reaching `level` and the smallest reaching `level + 1`, by bisection.
 * Solved for because the BitNode's part of the multiplier needs
 * Source-File 5 to read. undefined if no multiplier reaches `level`.
 */
export function effectiveSkillMult(level: number, skillAt: (mult: number) => number): number | undefined {
  const lowestReaching = (lvl: number): number | undefined => {
    let lo = 0;
    let hi = 1;
    while (skillAt(hi) < lvl) {
      hi *= 2;
      if (hi > 1e9) return undefined;
    }
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (skillAt(mid) >= lvl) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const a = lowestReaching(level);
  const b = lowestReaching(level + 1);
  return a === undefined || b === undefined ? undefined : (a + b) / 2;
}

/** The BitNode multiplier (ns.getBitNodeMultipliers) each skill's level is scaled by. */
export const SKILL_LEVEL_MULTIPLIER_KEY: Record<string, string> = {
  hacking: "HackingLevelMultiplier",
  strength: "StrengthLevelMultiplier",
  defense: "DefenseLevelMultiplier",
  dexterity: "DexterityLevelMultiplier",
  agility: "AgilityLevelMultiplier",
  charisma: "CharismaLevelMultiplier",
};

/**
 * A skill's total level multiplier: the player's own (augmentations and
 * Source-Files, ns.getPlayer().mults) times the BitNode's - exact, when the
 * BitNode multipliers are known (Source-File 5, via bitnode_info.ts).
 * Otherwise falls back to `solve()` (effectiveSkillMult from level and
 * experience), which is accurate but only to within a level's rounding.
 */
export function skillMultiplier(
  skill: string,
  playerMult: number,
  bitNodeMultipliers: Record<string, number> | undefined,
  solve: () => number | undefined
): { mult: number | undefined; source: "bitnode" | "solved" } {
  const bnMult = bitNodeMultipliers?.[SKILL_LEVEL_MULTIPLIER_KEY[skill] ?? ""];
  if (bnMult !== undefined) return { mult: playerMult * bnMult, source: "bitnode" };
  return { mult: solve(), source: "solved" };
}

/** Product of every augmentation's multipliers, key by key (ns.singularity.getAugmentationStats for each pending one). */
export function combineMultipliers(stats: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stats) for (const [key, value] of Object.entries(s)) out[key] = (out[key] ?? 1) * value;
  return out;
}

export type InstallComparison = {
  // Experience still to earn without installing, at today's rate.
  stayExp: number;
  // Experience to earn after installing - from 0, at the higher multiplier -
  // expressed in today's-rate terms (divided by the experience-gain boost).
  installExp: number;
  // installExp / stayExp: below 1, installing reaches the goal sooner.
  ratio: number;
};

/**
 * Whether installing pending augmentations now gets a skill to `goal`
 * sooner. `expFor(level, mult)` is ns.formulas.skills.calculateExp. An
 * install resets experience to 0 but multiplies the level multiplier by
 * `levelBoost` and the experience rate by `expBoost`. The rate itself
 * cancels out of the comparison, so no measured rate is needed.
 */
export function compareInstall(
  goal: number,
  exp: number,
  mult: number,
  levelBoost: number,
  expBoost: number,
  expFor: (level: number, mult: number) => number
): InstallComparison {
  const stayExp = Math.max(0, expFor(goal, mult) - exp);
  const installExp = expFor(goal, mult * levelBoost) / expBoost;
  return { stayExp, installExp, ratio: stayExp > 0 ? installExp / stayExp : Infinity };
}

/** Whether an augmentation's stats raise any of `focus` (multiplier keys like "hacking", "hacking_exp"); an empty focus matches everything. */
export function matchesFocus(stats: Record<string, number> | undefined, focus: string[]): boolean {
  if (focus.length === 0) return true;
  return focus.some((key) => (stats?.[key] ?? 1) > 1);
}
