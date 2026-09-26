import { describe, expect, it } from "vitest";
import { combineMultipliers, compareInstall, effectiveSkillMult, hackingGoal, matchesFocus } from "development/libraries/skill_progress";

// Bitburner's curve: level = floor(mult * (32 * ln(exp + 534.6) - 200)), at least 1.
const skill = (exp: number, mult: number): number => Math.max(Math.floor(mult * (32 * Math.log(exp + 534.6) - 200)), 1);
const expFor = (level: number, mult: number): number => Math.exp((level / mult + 200) / 32) - 534.6;

describe("hackingGoal", () => {
  it("prefers an explicit level, then w0r1d_d43m0n, then Daedalus", () => {
    expect(hackingGoal(3000, 6000)).toBe(3000);
    expect(hackingGoal(0, 6000)).toBe(6000);
    expect(hackingGoal(0, undefined)).toBe(2500);
  });
});

describe("effectiveSkillMult", () => {
  it("recovers the multiplier from level and experience (the pasted BN9 numbers)", () => {
    const m = effectiveSkillMult(1982, (mult) => skill(6.31e7, mult)) as number;
    expect(skill(6.31e7, m)).toBe(1982);
    expect(m).toBeCloseTo(5.29, 2);
  });

  it("gives up when no multiplier reaches the level", () => {
    expect(effectiveSkillMult(5, () => 1)).toBeUndefined();
  });
});

describe("combineMultipliers", () => {
  it("multiplies key by key", () => {
    expect(combineMultipliers([{ hacking: 1.1, hacking_exp: 1.2 }, { hacking: 1.1 }])).toEqual({ hacking: 1.1 * 1.1, hacking_exp: 1.2 });
  });

  it("is empty for no augmentations", () => {
    expect(combineMultipliers([])).toEqual({});
  });
});

describe("compareInstall", () => {
  it("favors installing when a level boost outweighs the lost experience", () => {
    const c = compareInstall(2500, 6.31e7, 5.29, 1.1, 1, expFor);
    expect(c.ratio).toBeLessThan(0.5);
  });

  it("disfavors installing with nothing that raises the level multiplier", () => {
    const c = compareInstall(2500, 6.31e7, 5.29, 1, 1, expFor);
    expect(c.ratio).toBeGreaterThan(1);
  });

  it("counts an experience-rate boost", () => {
    const plain = compareInstall(2500, 6.31e7, 5.29, 1, 1, expFor);
    const boosted = compareInstall(2500, 6.31e7, 5.29, 1, 2, expFor);
    expect(boosted.installExp).toBeCloseTo(plain.installExp / 2);
  });

  it("is infinite once the goal is already reached", () => {
    expect(compareInstall(1000, 6.31e7, 5.29, 1.1, 1, expFor).ratio).toBe(Infinity);
  });
});

describe("matchesFocus", () => {
  it("matches an augmentation that raises a focused multiplier", () => {
    expect(matchesFocus({ hacking: 1.05, strength: 1 }, ["hacking", "hacking_exp"])).toBe(true);
  });

  it("rejects one that only raises other multipliers", () => {
    expect(matchesFocus({ strength: 1.1, hacking: 1 }, ["hacking", "hacking_exp"])).toBe(false);
  });

  it("matches everything with an empty focus", () => {
    expect(matchesFocus(undefined, [])).toBe(true);
  });
});
