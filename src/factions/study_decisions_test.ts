import { describe, expect, it } from "vitest";
import { Activity, canAffordTraining, chooseTraining, CombatNeed, decideStudyStep, pickProgramToCreate, trainingCostPerMin, freeClass } from "factions/study_decisions";

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

describe("canAffordTraining", () => {
  it("needs cash for the whole runway", () => {
    expect(canAffordTraining(1000, 6e6, 10, 1e9)).toBe(false);
    expect(canAffordTraining(6e7, 6e6, 10, 1e9)).toBe(true);
  });

  it("always allows free training", () => {
    expect(canAffordTraining(0, 0, 10, 1e9)).toBe(true);
  });

  it("falls back to a minimum cash without a known cost", () => {
    expect(canAffordTraining(5e8, undefined, 10, 1e9)).toBe(false);
    expect(canAffordTraining(2e9, undefined, 10, 1e9)).toBe(true);
  });
});

describe("trainingCostPerMin", () => {
  it("turns a negative per-cycle money into a per-minute cost", () => {
    expect(trainingCostPerMin(-2000, 300)).toBe(600000);
    expect(trainingCostPerMin(0, 300)).toBe(0);
  });
});

describe("pickProgramToCreate", () => {
  const none = (): boolean => false;

  it("writes the first missing opener whose level is met and cash can't buy", () => {
    expect(pickProgramToCreate(none, 120, 144e3)).toBe("BruteSSH.exe");
    expect(pickProgramToCreate((n) => n === "BruteSSH.exe", 120, 144e3)).toBe("FTPCrack.exe");
  });

  it("leaves to the shopper what cash can buy, and skips what the level can't write", () => {
    expect(pickProgramToCreate(none, 120, 2e6)).toBeUndefined();
    expect(pickProgramToCreate(none, 40, 0)).toBeUndefined();
  });
});

describe("freeClass", () => {
  it("takes the free course at a university in the player's city", () => {
    expect(freeClass("Aevum", "ZB Institute of Technology", 0)).toEqual({ kind: "class", location: "Summit University", detail: "Computer Science" });
  });

  it("flies to the configured university when there's none here and the fare is affordable", () => {
    expect(freeClass("Chongqing", "ZB Institute of Technology", 1e6)?.location).toBe("ZB Institute of Technology");
    expect(freeClass("Chongqing", "ZB Institute of Technology", 1e5)).toBeUndefined();
  });
});
