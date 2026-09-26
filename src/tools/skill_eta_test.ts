import { describe, expect, it } from "vitest";
import { formatDuration, milestones, minutesToExp, sinceLastReset } from "tools/skill_eta";

describe("minutesToExp", () => {
  it("divides the remaining experience by the rate", () => {
    expect(minutesToExp(100, 700, 60)).toBe(10);
  });

  it("is 0 when already past the target", () => {
    expect(minutesToExp(800, 700, 60)).toBe(0);
  });

  it("is undefined without a positive rate", () => {
    expect(minutesToExp(100, 700, 0)).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("picks a readable unit", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(450)).toBe("7.5h");
    expect(formatDuration(60 * 24 * 3.2)).toBe("3.2d");
    expect(formatDuration(60 * 24 * 365 * 12)).toBe("12.0y");
    expect(formatDuration(60 * 24 * 365 * 3.4e9)).toBe("3.4e+9y");
    expect(formatDuration(undefined)).toBe("never");
  });
});

describe("milestones", () => {
  it("steps through round levels and ends at the target", () => {
    expect(milestones(870, 2500)).toEqual([1200, 1600, 2000, 2400, 2500]);
  });

  it("uses at least 100-level steps", () => {
    expect(milestones(870, 1000)).toEqual([900, 1000]);
  });

  it("returns just the target when already there", () => {
    expect(milestones(2600, 2500)).toEqual([2500]);
  });
});

describe("sinceLastReset", () => {
  it("keeps only points after the last drop", () => {
    expect(sinceLastReset([{ v: 5 }, { v: 9 }, { v: 1 }, { v: 3 }]).map((p) => p.v)).toEqual([1, 3]);
  });

  it("keeps everything when nothing dropped", () => {
    expect(sinceLastReset([{ v: 1 }, { v: 2 }]).map((p) => p.v)).toEqual([1, 2]);
  });
});
