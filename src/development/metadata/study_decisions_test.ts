import { describe, expect, it } from "vitest";
import { Activity, chooseTraining, CombatNeed, decideStudyStep } from "development/metadata/study_decisions";

describe("decideStudyStep", () => {
  const zb: Activity = { kind: "class", location: "ZB Institute of Technology", detail: "Algorithms" };
  const powerhouse: Activity = { kind: "gym", location: "Powerhouse Gym", detail: "str", stat: "strength" };

  it("does nothing outside GROW_STATS", () => {
    expect(decideStudyStep(false, zb, "Sector-12", null)).toEqual({ kind: "idle" });
  });

  it("travels to the location's city first", () => {
    expect(decideStudyStep(true, zb, "Sector-12", null)).toEqual({ kind: "travel", city: "Volhaven" });
    expect(decideStudyStep(true, powerhouse, "Volhaven", null)).toEqual({ kind: "travel", city: "Sector-12" });
  });

  it("starts once in the right city", () => {
    expect(decideStudyStep(true, zb, "Volhaven", { type: "FACTION" })).toEqual({ kind: "start" });
    expect(decideStudyStep(true, powerhouse, "Sector-12", null)).toEqual({ kind: "start" });
  });

  it("leaves the matching activity alone", () => {
    expect(decideStudyStep(true, zb, "Volhaven", { type: "CLASS", location: zb.location, classType: "Algorithms" })).toEqual({ kind: "busy" });
    expect(decideStudyStep(true, powerhouse, "Sector-12", { type: "CLASS", location: "Powerhouse Gym", classType: "str" })).toEqual({ kind: "busy" });
  });

  it("switches when a different workout is running", () => {
    expect(decideStudyStep(true, powerhouse, "Sector-12", { type: "CLASS", location: "Powerhouse Gym", classType: "def" })).toEqual({ kind: "start" });
  });

  it("flags an unknown location", () => {
    expect(decideStudyStep(true, { kind: "class", location: "Iron Gym", detail: "Algorithms" }, "Sector-12", null)).toEqual({ kind: "unknownLocation" });
  });
});

describe("chooseTraining", () => {
  const need = (stat: string, minutes: number): CombatNeed => ({ stat, gymType: stat.slice(0, 3), gym: "Powerhouse Gym", minutes });
  const combat = [need("strength", 0), need("defense", 2), need("dexterity", 5), need("agility", 1)];

  it("trains the first unfinished stat when the combat route is faster", () => {
    expect(chooseTraining(3500, combat, true)?.stat).toBe("defense");
  });

  it("studies when hacking finishes sooner", () => {
    expect(chooseTraining(5, combat, true)).toBeUndefined();
  });

  it("studies once the combat route no longer matters", () => {
    expect(chooseTraining(3500, combat, false)).toBeUndefined();
  });

  it("studies once every combat stat is done", () => {
    expect(chooseTraining(3500, [need("strength", 0), need("defense", 0)], true)).toBeUndefined();
  });
});
