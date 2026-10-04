import { describe, expect, it } from "vitest";
import { derivePhase, parseApproach, parseApproachOverride, phasePolicy } from "system/phase";
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
  it("is GANG while a gang is possible but not created", () => {
    expect(derivePhase(true, false).approach).toBe(Approach.GANG);
  });

  it("is AUGMENTS once the gang exists, or when gangs aren't possible", () => {
    expect(derivePhase(true, true).approach).toBe(Approach.AUGMENTS);
    expect(derivePhase(false, false).approach).toBe(Approach.AUGMENTS);
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

  it("hands the work slot to studying in GROW_STATS", () => {
    expect(phasePolicy(Approach.GROW_STATS)).toMatchObject({ studyForStats: true, focusAugmentations: true, installLoop: false });
  });
});
