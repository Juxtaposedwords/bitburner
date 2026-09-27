import { describe, expect, it } from "vitest";
import { parseApproach } from "development/libraries/approach";
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
