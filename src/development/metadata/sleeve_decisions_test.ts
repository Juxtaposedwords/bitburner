import { describe, expect, it } from "vitest";
import { bestCrimeBy, decideSleeveGoals, SleeveContext, sleevesAvailable, syncPaysOff, taskMatchesGoal, updateSyncRate } from "development/metadata/sleeve_decisions";

const ctx = (overrides: Partial<SleeveContext> = {}): SleeveContext => ({
  karmaCrimeFor: () => undefined,
  moneyCrimeFor: () => "Rob Store",
  repGaps: {},
  maxShock: 0,
  minSync: 100,
  ...overrides,
});
const ready = (index: number) => ({ index, shock: 0, sync: 100 });

describe("decideSleeveGoals", () => {
  it("puts gang karma first, even over recovery", () => {
    const goals = decideSleeveGoals([{ index: 0, shock: 90, sync: 5 }], ctx({ karmaCrimeFor: () => "Mug" }));
    expect(goals).toEqual([{ kind: "karmaCrime", crime: "Mug" }]);
  });

  it("recovers shock, then synchronizes, before working", () => {
    expect(decideSleeveGoals([{ index: 0, shock: 50, sync: 5 }], ctx())).toEqual([{ kind: "recovery" }]);
    expect(decideSleeveGoals([{ index: 0, shock: 0, sync: 50 }], ctx())).toEqual([{ kind: "sync" }]);
  });

  it("spreads sleeves over factions short of rep, closest first, never the player's", () => {
    const goals = decideSleeveGoals(
      [ready(0), ready(1), ready(2)],
      ctx({ repGaps: { Illuminati: 400000, "The Covenant": 50000, CyberSec: 1000 }, playerFaction: "CyberSec" })
    );
    expect(goals).toEqual([
      { kind: "faction", faction: "The Covenant" },
      { kind: "faction", faction: "Illuminati" },
      { kind: "moneyCrime", crime: "Rob Store" },
    ]);
  });
});

describe("taskMatchesGoal", () => {
  it("recognizes the task already running", () => {
    expect(taskMatchesGoal({ type: "CRIME", crimeType: "Mug" }, { kind: "karmaCrime", crime: "Mug" })).toBe(true);
    expect(taskMatchesGoal({ type: "FACTION", factionName: "Illuminati" }, { kind: "faction", faction: "Illuminati" })).toBe(true);
    expect(taskMatchesGoal({ type: "RECOVERY" }, { kind: "recovery" })).toBe(true);
  });

  it("notices a different task", () => {
    expect(taskMatchesGoal({ type: "CRIME", crimeType: "Mug" }, { kind: "karmaCrime", crime: "Homicide" })).toBe(false);
    expect(taskMatchesGoal(null, { kind: "sync" })).toBe(false);
  });
});

describe("bestCrimeBy", () => {
  it("maximizes value x chance / time", () => {
    const crimes = [
      { crime: "Homicide", value: 3, timeMs: 3000, successChance: 0.05 },
      { crime: "Mug", value: 0.25, timeMs: 4000, successChance: 0.9 },
    ];
    expect(bestCrimeBy(crimes)).toBe("Mug");
    expect(bestCrimeBy([{ ...crimes[0], successChance: 0.9 }, crimes[1]])).toBe("Homicide");
  });

  it("is undefined when nothing can succeed", () => {
    expect(bestCrimeBy([{ crime: "Homicide", value: 3, timeMs: 3000, successChance: 0 }])).toBeUndefined();
  });
});

describe("sleevesAvailable", () => {
  it("needs BitNode 10 or Source-File 10", () => {
    expect(sleevesAvailable(10, {})).toBe(true);
    expect(sleevesAvailable(9, { "10": 1 })).toBe(true);
    expect(sleevesAvailable(9, { "5": 3 })).toBe(false);
  });
});

describe("karma phase with syncFirstFor", () => {
  it("synchronizes first when told to, otherwise commits the crime", () => {
    expect(decideSleeveGoals([ready(0)], ctx({ karmaCrimeFor: () => "Homicide", syncFirstFor: () => true }))).toEqual([{ kind: "sync" }]);
    expect(decideSleeveGoals([ready(0)], ctx({ karmaCrimeFor: () => "Homicide", syncFirstFor: () => false }))).toEqual([
      { kind: "karmaCrime", crime: "Homicide" },
    ]);
  });
});

describe("syncPaysOff", () => {
  // Rates in karma per ms: player 0.8/s, sleeve 0.5/s at full sync.
  const player = 0.8 / 1000;
  const sleeve = 0.5 / 1000;

  it("syncs first when sync is fast and lots of karma is left", () => {
    expect(syncPaysOff(42000, player, sleeve, 25, 2)).toBe(true);
  });

  it("keeps the crime going when syncing would take too long", () => {
    expect(syncPaysOff(42000, player, sleeve, 25, 0.01)).toBe(false);
  });

  it("never syncs a fully synced sleeve or with no measured rate", () => {
    expect(syncPaysOff(42000, player, sleeve, 100, 2)).toBe(false);
    expect(syncPaysOff(42000, player, sleeve, 25, 0)).toBe(false);
  });
});

describe("updateSyncRate", () => {
  const at = (sync: number, minutes: number, syncing = true) => ({ sync, t: minutes * 60_000, syncing });

  it("measures points per minute across readings a minute or more apart", () => {
    expect(updateSyncRate(at(25, 0), at(27, 2), undefined)).toBe(1);
  });

  it("blends with an earlier estimate", () => {
    expect(updateSyncRate(at(25, 0), at(27, 2), 3)).toBe(2);
  });

  it("ignores readings too close together, or while not synchronizing", () => {
    expect(updateSyncRate(at(25, 0), at(25.5, 0.5), undefined)).toBeUndefined();
    expect(updateSyncRate(at(25, 0, false), at(27, 2), 4)).toBe(4);
  });
});
