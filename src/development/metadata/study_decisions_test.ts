import { describe, expect, it } from "vitest";
import { decideStudyStep } from "development/metadata/study_decisions";

describe("decideStudyStep", () => {
  const zb = "ZB Institute of Technology";

  it("does nothing outside GROW_STATS", () => {
    expect(decideStudyStep(false, zb, "Algorithms", "Sector-12", null)).toEqual({ kind: "idle" });
  });

  it("travels to the university's city first", () => {
    expect(decideStudyStep(true, zb, "Algorithms", "Sector-12", null)).toEqual({ kind: "travel", city: "Volhaven" });
  });

  it("enrolls once in the right city", () => {
    expect(decideStudyStep(true, zb, "Algorithms", "Volhaven", { type: "FACTION" })).toEqual({ kind: "enroll" });
  });

  it("leaves the matching class alone", () => {
    const current = { type: "CLASS", location: zb, classType: "Algorithms" };
    expect(decideStudyStep(true, zb, "Algorithms", "Volhaven", current)).toEqual({ kind: "studying" });
  });

  it("re-enrolls when a different course is running", () => {
    const current = { type: "CLASS", location: zb, classType: "Networks" };
    expect(decideStudyStep(true, zb, "Algorithms", "Volhaven", current)).toEqual({ kind: "enroll" });
  });

  it("flags an unknown university", () => {
    expect(decideStudyStep(true, "Iron Gym", "Algorithms", "Sector-12", null)).toEqual({ kind: "unknownUniversity" });
  });
});
