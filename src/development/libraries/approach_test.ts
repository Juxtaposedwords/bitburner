import { describe, expect, it } from "vitest";
import { derivePhase, parseApproach, parseApproachOverride } from "development/libraries/approach";
import { Approach } from "development/metadata/scheduler";

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
