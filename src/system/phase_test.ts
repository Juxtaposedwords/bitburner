import { describe, expect, it } from "vitest";
import { derivePhase, parseApproach, parseApproachOverride, PhaseInputs, phasePolicy, requiredHackingMult } from "system/phase";
import { Approach } from "system/rpc/scheduler";

describe("parseApproach", () => {
  it("reads the persisted enum number", () => {
    expect(parseApproach(JSON.stringify({ approach: 4 }))).toBe(Approach.AUGMENTS);
  });

  it("accepts a hand-edited enum name", () => {
    expect(parseApproach(JSON.stringify({ approach: "GROW_STATS" }))).toBe(Approach.GROW_STATS);
  });

  it("falls back to HACK for missing, unknown, or corrupt contents", () => {
    expect(parseApproach("")).toBe(Approach.HACK);
    expect(parseApproach(JSON.stringify({}))).toBe(Approach.HACK);
    expect(parseApproach(JSON.stringify({ approach: 99 }))).toBe(Approach.HACK);
    expect(parseApproach("{bad")).toBe(Approach.HACK);
  });
});

describe("parseApproachOverride", () => {
  it("is undefined without an explicit approach, so the phase decides", () => {
    expect(parseApproachOverride("")).toBeUndefined();
    expect(parseApproachOverride(JSON.stringify({ hackFraction: 0.5 }))).toBeUndefined();
    expect(parseApproachOverride(JSON.stringify({ approach: 6 }))).toBe(Approach.FACTION_GRIND);
  });
});

describe("derivePhase", () => {
  const base: PhaseInputs = { gangAvailable: true, inGang: true, donationReady: true, pursueFinish: true, hackingMult: 3, requiredHackingMult: 4.4, inDaedalus: false };

  it("is GANG while a gang is possible but not created", () => {
    expect(derivePhase({ ...base, inGang: false }).approach).toBe(Approach.GANG);
  });

  it("grinds favor until some faction takes donations", () => {
    expect(derivePhase({ ...base, donationReady: false }).approach).toBe(Approach.FACTION_GRIND);
  });

  it("multiplies (AUGMENTS) with donations open and the multiplier short", () => {
    expect(derivePhase(base).approach).toBe(Approach.AUGMENTS);
    expect(derivePhase({ ...base, gangAvailable: false, inGang: false }).approach).toBe(Approach.AUGMENTS);
  });

  it("goes for Daedalus once the multiplier is enough or Daedalus is joined, only when pursuing the finish", () => {
    expect(derivePhase({ ...base, hackingMult: 4.5 }).approach).toBe(Approach.DAEDALUS);
    expect(derivePhase({ ...base, inDaedalus: true, donationReady: false }).approach).toBe(Approach.DAEDALUS);
    expect(derivePhase({ ...base, hackingMult: 9, pursueFinish: false }).approach).toBe(Approach.AUGMENTS);
  });
});

describe("requiredHackingMult", () => {
  it("matches the game's skill formula", () => {
    // BN12: level 1018 at 2.42e7 exp is a 2.96 multiplier.
    expect(requiredHackingMult(1018, 2.42e7)).toBeCloseTo(2.96, 2);
    expect(requiredHackingMult(2500, 3e10)).toBeGreaterThan(4);
  });
});

describe("phasePolicy", () => {
  it("chases karma and keeps share off in GANG", () => {
    const policy = phasePolicy(Approach.GANG);
    expect(policy.chaseGangKarma).toBe(true);
    expect(policy.installLoop).toBe(false);
    expect(policy.shareByDefault).toBe(false);
  });

  it("runs the focused install loop in AUGMENTS", () => {
    expect(phasePolicy(Approach.AUGMENTS)).toMatchObject({ installLoop: true, focusAugmentations: true, chaseGangKarma: false, shareByDefault: true });
  });

  it("aims FACTION_GRIND at donation favor, and DAEDALUS at the Red Pill only", () => {
    expect(phasePolicy(Approach.FACTION_GRIND)).toMatchObject({ donationTarget: true, grindFactions: true, redPillOnly: false });
    expect(phasePolicy(Approach.DAEDALUS)).toMatchObject({ redPillOnly: true, grindFactions: true, installLoop: false, donationTarget: false });
  });

  it("hands the work slot to studying in GROW_STATS", () => {
    expect(phasePolicy(Approach.GROW_STATS)).toMatchObject({ studyForStats: true, focusAugmentations: true, installLoop: false });
  });
});

describe("goWeights", () => {
  it("favors crime success while chasing gang karma, reputation in the install loop", () => {
    const top = (w: Record<string, number>): string => Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
    expect(top(phasePolicy(Approach.GANG).goWeights)).toBe("Slum Snakes");
    expect(top(phasePolicy(Approach.AUGMENTS).goWeights)).toBe("Daedalus");
  });
});
