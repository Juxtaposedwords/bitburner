import { describe, expect, it } from "vitest";
import { bestCrimeBy, decideSleeveGoals, decideSleeveInvestment, pickSleeveAug, SleeveContext, sleevesAvailable, sleeveTrainingPaysOff, syncPaysOff, taskMatchesGoal, updateSyncRate } from "sleeves/sleeve_decisions";

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

  it("joins the player's faction first, then spreads over the rest, closest first", () => {
    const goals = decideSleeveGoals(
      [ready(0), ready(1), ready(2), ready(3)],
      ctx({ repGaps: { Illuminati: 400000, "The Covenant": 50000, CyberSec: 1000 }, playerFaction: "Illuminati" })
    );
    expect(goals).toEqual([
      { kind: "faction", faction: "Illuminati" },
      { kind: "faction", faction: "CyberSec" },
      { kind: "faction", faction: "The Covenant" },
      { kind: "moneyCrime", crime: "Rob Store" },
    ]);
  });

  it("doesn't join the player's faction once it has no gap left", () => {
    const goals = decideSleeveGoals([ready(0)], ctx({ repGaps: { Illuminati: 0, CyberSec: 1000 }, playerFaction: "Illuminati" }));
    expect(goals).toEqual([{ kind: "faction", faction: "CyberSec" }]);
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

describe("decideSleeveInvestment", () => {
  const memory = [
    { index: 0, memory: 40, upgradeCost: 1e9 },
    { index: 1, memory: 10, upgradeCost: 1e9 },
    { index: 2, memory: 100, upgradeCost: Infinity },
  ];

  it("does nothing outside BitNode 10", () => {
    expect(decideSleeveInvestment(9, true, 1e15, 1e12, memory)).toEqual({ buySleeve: false });
  });

  it("buys a sleeve when a Covenant member can afford it, then upgrades the lowest memory", () => {
    expect(decideSleeveInvestment(10, true, 2e12, 1e12, memory)).toEqual({ buySleeve: true, memoryFor: 1 });
  });

  it("only upgrades memory when not a member, or the sleeve is out of reach", () => {
    expect(decideSleeveInvestment(10, false, 2e12, 1e12, memory)).toEqual({ buySleeve: false, memoryFor: 1 });
    expect(decideSleeveInvestment(10, true, 5e11, 1e12, memory)).toEqual({ buySleeve: false, memoryFor: 1 });
    expect(decideSleeveInvestment(10, true, 1e15, Infinity, memory).buySleeve).toBe(false);
  });

  it("skips memory upgrades it can't afford or that are maxed", () => {
    expect(decideSleeveInvestment(10, false, 1e8, 1e12, memory)).toEqual({ buySleeve: false, memoryFor: undefined });
  });
});

describe("sleeve karma training", () => {
  it("trains when the horizon is long enough to win the gym time back", () => {
    // Homicide: 3 karma, 3s. 20% -> 60% after 20 minutes of gym, 10 hours left.
    expect(sleeveTrainingPaysOff(10 * 3600_000, 3, 3000, 0.2, 0.6, 20 * 60_000)).toBe(true);
  });

  it("stops training once the crime succeeds often enough", () => {
    expect(sleeveTrainingPaysOff(10 * 3600_000, 3, 3000, 0.8, 0.9, 1)).toBe(false);
  });

  it("doesn't train when the gang is nearly there", () => {
    expect(sleeveTrainingPaysOff(15 * 60_000, 3, 3000, 0.2, 0.6, 20 * 60_000)).toBe(false);
    expect(sleeveTrainingPaysOff(Infinity, 3, 3000, 0.2, 0.6, 20 * 60_000)).toBe(false);
  });

  it("sends a karma-phase sleeve to the gym when that pays, and recognizes the gym task", () => {
    const goals = decideSleeveGoals([{ index: 0, shock: 15, sync: 100 }], {
      karmaCrimeFor: () => "Homicide",
      karmaTrainingFor: () => ({ stat: "str", gym: "Powerhouse Gym" }),
      moneyCrimeFor: () => "Mug",
      repGaps: {},
      maxShock: 0,
      minSync: 100,
    });
    expect(goals).toEqual([{ kind: "gym", stat: "str", gym: "Powerhouse Gym", purpose: "karma" }]);
    expect(taskMatchesGoal({ type: "CLASS", classType: "str", location: "Powerhouse Gym" }, goals[0])).toBe(true);
    expect(taskMatchesGoal({ type: "CLASS", classType: "dex", location: "Powerhouse Gym" }, goals[0])).toBe(false);
  });
});

describe("sleeves with no rep left to earn", () => {
  const base = {
    karmaCrimeFor: () => undefined,
    moneyCrimeFor: () => "Mug",
    maxShock: 0,
    minSync: 100,
  };
  const study = { kind: "study" as const, course: "Algorithms", university: "ZB Institute of Technology" };

  it("train for the player once every rep target has a worker, and go back to rep work when one appears", () => {
    const sleeves = [0, 1, 2].map((index) => ({ index, shock: 0, sync: 100 }));
    expect(decideSleeveGoals(sleeves, { ...base, repGaps: { CyberSec: 1000 }, trainingFor: () => study })).toEqual([
      { kind: "faction", faction: "CyberSec" },
      study,
      study,
    ]);
    expect(decideSleeveGoals(sleeves, { ...base, repGaps: { CyberSec: 1000, NiteSec: 5000 }, trainingFor: () => study })[1]).toEqual({
      kind: "faction",
      faction: "NiteSec",
    });
  });

  it("commit money crimes when training isn't offered (cash too low)", () => {
    expect(decideSleeveGoals([{ index: 0, shock: 0, sync: 100 }], { ...base, repGaps: {}, trainingFor: () => undefined })).toEqual([
      { kind: "moneyCrime", crime: "Mug" },
    ]);
  });

  it("recognizes a running class", () => {
    expect(taskMatchesGoal({ type: "CLASS", classType: "Algorithms", location: "ZB Institute of Technology" }, study)).toBe(true);
  });
});

describe("pickSleeveAug", () => {
  const opt = (index: number, name: string, cost: number, stats: Record<string, number>, shock = 0) => ({ index, name, cost, stats, shock });

  it("buys the cheapest useful augmentation that fits the budget", () => {
    const options = [opt(0, "Synfibril Muscle", 5e9, { strength: 1.3 }), opt(1, "Wired Reflexes", 1e8, { agility: 1.05 }), opt(0, "BitWire", 2e8, { hacking: 1.05 })];
    expect(pickSleeveAug(options, 1e10)?.name).toBe("Wired Reflexes");
    expect(pickSleeveAug(options, 5e7)).toBeUndefined();
  });

  it("skips augmentations that don't help sleeves, and sleeves still in shock", () => {
    const options = [opt(0, "Hacknet Node Core Direct-Neural Interface", 1e6, { hacknet_node_money: 1.45 }), opt(1, "BitWire", 2e8, { hacking: 1.05 }, 20)];
    expect(pickSleeveAug(options, 1e12)).toBeUndefined();
  });
});

describe("sleeves on company work", () => {
  const base = { karmaCrimeFor: () => undefined, moneyCrimeFor: () => "Mug", maxShock: 0, minSync: 100 };
  const study = { kind: "study" as const, course: "Algorithms", university: "ZB Institute of Technology" };

  it("work corporate invites after faction rep and before training, one sleeve per company", () => {
    const sleeves = [0, 1, 2, 3].map((index) => ({ index, shock: 0, sync: 100 }));
    expect(
      decideSleeveGoals(sleeves, { ...base, repGaps: { NiteSec: 1000 }, companies: ["MegaCorp", "ECorp"], trainingFor: () => study })
    ).toEqual([{ kind: "faction", faction: "NiteSec" }, { kind: "company", company: "MegaCorp" }, { kind: "company", company: "ECorp" }, study]);
  });

  it("recognizes company work already running", () => {
    expect(taskMatchesGoal({ type: "COMPANY", companyName: "ECorp" }, { kind: "company", company: "ECorp" })).toBe(true);
    expect(taskMatchesGoal({ type: "COMPANY", companyName: "MegaCorp" }, { kind: "company", company: "ECorp" })).toBe(false);
  });
});
