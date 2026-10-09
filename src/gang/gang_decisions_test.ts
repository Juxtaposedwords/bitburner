import { describe, expect, it } from "vitest";
import { gangObjective, gangFactionFor, skipRecentlyAscended,
  AscensionCandidate,
  AscensionResult,
  decideAscension,
  decideEquipmentPurchase,
  decideMemberTask,
  decideStandDown,
  decideTerritoryReadiness,
  decideTerritoryWarfareAssignment,
  decideTrainingTask,
  detectCasualties,
  EquipmentOption,
  selectBestAscensionCandidate,
  TaskOption,
  WantedPolicy, worstClashWinChance, karmaBlocksGang, nextMemberName, stateForNode, skipEquipmentBeforeAscension, ascensionThreshold } from "gang/gang_decisions";
import { GangPosture } from "gang/gang";

const task = (overrides: Partial<TaskOption> = {}): TaskOption => ({
  name: "Task",
  moneyGain: 0,
  wantedLevelGain: 0,
  respectGain: 0,
  ...overrides,
});

const policy = (overrides: Partial<WantedPolicy> = {}): WantedPolicy => ({
  minWantedPenalty: 0.9,
  wantedReductionFraction: 0.2,
  ...overrides,
});

describe("decideMemberTask", () => {
  it("picks the highest-moneyGain task when wanted penalty is at full strength (1.0, no penalty)", () => {
    const options = [task({ name: "Mug", moneyGain: 10 }), task({ name: "Deal Drugs", moneyGain: 50 })];
    expect(decideMemberTask(0, 5, 1, policy(), options)).toBe("Deal Drugs");
  });

  it("switches reserved members to the lowest-wantedLevelGain task once wantedPenalty drops below the floor", () => {
    const options = [
      task({ name: "Money", moneyGain: 50, wantedLevelGain: 5 }),
      task({ name: "Vigilante", moneyGain: 0, wantedLevelGain: -10 }),
    ];
    // 5 members, wantedReductionFraction 0.2 -> 1 member reserved (index 0). wantedPenalty=0.5 is well below the 0.9 floor.
    expect(decideMemberTask(0, 5, 0.5, policy(), options)).toBe("Vigilante");
  });

  it("leaves non-reserved members on the money-maximizing task even while wantedPenalty is low", () => {
    const options = [
      task({ name: "Money", moneyGain: 50, wantedLevelGain: 5 }),
      task({ name: "Vigilante", moneyGain: 0, wantedLevelGain: -10 }),
    ];
    expect(decideMemberTask(1, 5, 0.5, policy(), options)).toBe("Money");
  });

  it("doesn't reserve anyone for a wantedPenalty just barely at the floor - a healthy gang stays near 1.0", () => {
    const options = [task({ name: "Money", moneyGain: 50, wantedLevelGain: 5 }), task({ name: "Vigilante", moneyGain: 0, wantedLevelGain: -10 })];
    expect(decideMemberTask(0, 5, 0.995, policy(), options)).toBe("Money");
  });

  it("reserves at least one member once wantedPenalty drops below the floor, even with a tiny roster", () => {
    const options = [task({ name: "Money", moneyGain: 50, wantedLevelGain: 5 }), task({ name: "Vigilante", moneyGain: 0, wantedLevelGain: -10 })];
    expect(decideMemberTask(0, 1, 0.5, policy(), options)).toBe("Vigilante");
  });

  it("returns undefined when there are no task options", () => {
    expect(decideMemberTask(0, 5, 1, policy(), [])).toBeUndefined();
  });
});

describe("decideEquipmentPurchase", () => {
  const equip = (overrides: Partial<EquipmentOption> = {}): EquipmentOption => ({ member: "Bob", name: "Item", cost: 100, ...overrides });

  it("buys the cheapest affordable candidate", () => {
    const candidates = [equip({ name: "Cheap", cost: 100 }), equip({ name: "Pricey", cost: 900 })];
    expect(decideEquipmentPurchase(1000, 0, 1, candidates)).toEqual(equip({ name: "Cheap", cost: 100 }));
  });

  it("respects reserveMoney and maxSpendFraction the same way decideNodeInvestment does", () => {
    const candidates = [equip({ cost: 600 })];
    expect(decideEquipmentPurchase(1000, 500, 1, candidates)).toBeUndefined();
  });

  it("returns undefined when nothing is affordable", () => {
    expect(decideEquipmentPurchase(10, 0, 1, [equip({ cost: 100 })])).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(decideEquipmentPurchase(1_000_000, 0, 1, [])).toBeUndefined();
  });
});

describe("decideAscension", () => {
  const ascension = (overrides: Partial<AscensionResult> = {}): AscensionResult => ({
    hack: 1,
    str: 1,
    def: 1,
    dex: 1,
    agi: 1,
    cha: 1,
    ...overrides,
  });

  it("ascends when the average multiplier gain meets the threshold", () => {
    expect(decideAscension(ascension({ hack: 1.2, str: 1.2, def: 1.2, dex: 1.2, agi: 1.2, cha: 1.2 }), 1.1)).toBe(true);
  });

  it("doesn't ascend when the average multiplier gain is below the threshold", () => {
    expect(decideAscension(ascension({ hack: 1.02 }), 1.1)).toBe(false);
  });

  it("doesn't ascend when no ascension is possible (undefined result)", () => {
    expect(decideAscension(undefined, 1.1)).toBe(false);
  });

  it("ascends a combat member with strong combat-stat gains even though hack stayed untrained at ~1.0 - the live bug", () => {
    // hack never trains for a combat-focused member, so its factor sits
    // at baseline while the stats they actually use show a real gain.
    // Averaging in the untrained hack factor would have dragged this
    // below 1.1 even though every stat this member cares about cleared it.
    const combatMember = ascension({ hack: 1.0, str: 1.3, def: 1.3, dex: 1.3, agi: 1.3, cha: 1.3 });
    expect(decideAscension(combatMember, 1.1)).toBe(true);
  });

  it("returns no gain (average of 1) when every stat is untrained", () => {
    expect(decideAscension(ascension(), 1.0 + Number.EPSILON)).toBe(false);
  });

  it("ascends right at the threshold (inclusive)", () => {
    // Integer values avoid floating-point rounding at the boundary check.
    expect(decideAscension(ascension({ hack: 2, str: 2, def: 2, dex: 2, agi: 2, cha: 2 }), 2)).toBe(true);
  });
});

describe("decideTrainingTask", () => {
  const ascension = (overrides: Partial<AscensionResult> = {}): AscensionResult => ({
    hack: 1,
    str: 1,
    def: 1,
    dex: 1,
    agi: 1,
    cha: 1,
    ...overrides,
  });

  it("returns undefined when not close enough to the threshold yet", () => {
    // 1.05 average, threshold 1.1, readyMargin 0.95 -> ready point is 1.045 - still short.
    const allSix = (v: number) => ascension({ hack: v, str: v, def: v, dex: v, agi: v, cha: v });
    expect(decideTrainingTask(allSix(1.04), 1.1, 0.95, false)).toBeUndefined();
  });

  it("returns Train Combat for a combat gang once within the ready margin", () => {
    const allSix = (v: number) => ascension({ hack: v, str: v, def: v, dex: v, agi: v, cha: v });
    expect(decideTrainingTask(allSix(1.05), 1.1, 0.95, false)).toBe("Train Combat");
  });

  it("returns Train Hacking for a hacking gang once within the ready margin", () => {
    const allSix = (v: number) => ascension({ hack: v, str: v, def: v, dex: v, agi: v, cha: v });
    expect(decideTrainingTask(allSix(1.05), 1.1, 0.95, true)).toBe("Train Hacking");
  });

  it("returns a task once already past the threshold, not just approaching it", () => {
    const allSix = (v: number) => ascension({ hack: v, str: v, def: v, dex: v, agi: v, cha: v });
    expect(decideTrainingTask(allSix(1.2), 1.1, 0.95, false)).toBe("Train Combat");
  });

  it("returns undefined when no ascension is possible (undefined result)", () => {
    expect(decideTrainingTask(undefined, 1.1, 0.95, false)).toBeUndefined();
  });
});

describe("selectBestAscensionCandidate", () => {
  const ascension = (overrides: Partial<AscensionResult> = {}): AscensionResult => ({
    hack: 1,
    str: 1,
    def: 1,
    dex: 1,
    agi: 1,
    cha: 1,
    ...overrides,
  });
  const candidate = (member: string, result: AscensionResult | undefined): AscensionCandidate => ({ member, result });

  it("picks at most one member even when every candidate is eligible - prevents crashing the whole gang's respect in one tick", () => {
    const candidates = [
      candidate("A", ascension({ hack: 3 })),
      candidate("B", ascension({ hack: 3 })),
      candidate("C", ascension({ hack: 3 })),
    ];
    const chosen = selectBestAscensionCandidate(candidates, 1.1);
    expect(["A", "B", "C"]).toContain(chosen);
  });

  it("picks the candidate with the highest average multiplier gain among eligible ones", () => {
    const candidates = [candidate("Low", ascension({ hack: 1.2 })), candidate("High", ascension({ hack: 3 }))];
    expect(selectBestAscensionCandidate(candidates, 1.1)).toBe("High");
  });

  it("skips candidates below the threshold entirely", () => {
    const allSix = (v: number) => ascension({ hack: v, str: v, def: v, dex: v, agi: v, cha: v });
    const candidates = [candidate("TooLow", allSix(1.02)), candidate("Good", allSix(1.5))];
    expect(selectBestAscensionCandidate(candidates, 1.1)).toBe("Good");
  });

  it("returns undefined when nobody is eligible", () => {
    const candidates = [candidate("A", ascension({ hack: 1.02 })), candidate("B", undefined)];
    expect(selectBestAscensionCandidate(candidates, 1.1)).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(selectBestAscensionCandidate([], 1.1)).toBeUndefined();
  });
});

describe("decideTerritoryWarfareAssignment", () => {
  it("assigns nobody when posture is CONSOLIDATE, regardless of desiredCount", () => {
    expect(decideTerritoryWarfareAssignment(GangPosture.CONSOLIDATE, false, 12, 2)).toBe(0);
  });

  it("assigns nobody when standing down, even if posture is GROWING", () => {
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, true, 12, 2)).toBe(0);
  });

  it("assigns the desired count when GROWING and not standing down", () => {
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 12, 2)).toBe(2);
  });

  it("clamps the desired count to the roster size", () => {
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 1, 2)).toBe(1);
  });

  it("assigns nobody once no rival holds territory", () => {
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 12, 6, false)).toBe(0);
  });

  it("always leaves minEarners members earning, and puts the rest on warfare early", () => {
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 3, 12, true, 3)).toBe(0);
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 7, 12, true, 3)).toBe(4);
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 12, 12, true, 3)).toBe(9);
    expect(decideTerritoryWarfareAssignment(GangPosture.GROWING, false, 12, 6, true, 3)).toBe(6);
  });
});

describe("decideTerritoryReadiness", () => {
  it("is ready when there are no rivals holding territory at all", () => {
    expect(decideTerritoryReadiness(100, [], 0.65)).toBe(true);
  });

  it("is ready when power favors us against every rival above the margin", () => {
    // 100/(100+10) ≈ 0.909, well above 0.65.
    expect(decideTerritoryReadiness(100, [10, 20], 0.65)).toBe(true);
  });

  it("is not ready if even one rival brings win chance below the margin", () => {
    // 100/(100+90) ≈ 0.526, below 0.65.
    expect(decideTerritoryReadiness(100, [10, 90], 0.65)).toBe(false);
  });

  it("is not ready when evenly matched with a rival (0.5 win chance) against a 0.65 margin", () => {
    expect(decideTerritoryReadiness(100, [100], 0.65)).toBe(false);
  });
});

describe("detectCasualties", () => {
  it("reports zero when the member count matches expectations exactly", () => {
    expect(detectCasualties(12, 12, 0)).toBe(0);
  });

  it("reports zero when a recruit fully explains the count increase", () => {
    expect(detectCasualties(12, 13, 1)).toBe(0);
  });

  it("detects a death when the count dropped with no recruit", () => {
    expect(detectCasualties(12, 11, 0)).toBe(1);
  });

  it("detects a death even when masked by a same-tick recruit (net count unchanged)", () => {
    // 12 -> 13 recruited -> 12 actual means one died alongside the recruit.
    expect(detectCasualties(12, 12, 1)).toBe(1);
  });

  it("never reports a negative count", () => {
    expect(detectCasualties(12, 15, 0)).toBe(0);
  });
});

describe("decideStandDown", () => {
  it("is false while casualties stay under the threshold", () => {
    expect(decideStandDown(0, 1)).toBe(false);
  });

  it("trips right at the threshold (inclusive)", () => {
    expect(decideStandDown(1, 1)).toBe(true);
  });

  it("stays tripped past the threshold", () => {
    expect(decideStandDown(3, 1)).toBe(true);
  });
});

describe("worstClashWinChance", () => {
  it("is the chance against the strongest rival", () => {
    expect(worstClashWinChance(100, [50, 194])).toBeCloseTo(100 / 294);
  });

  it("is 1 with no rivals holding territory", () => {
    expect(worstClashWinChance(100, [])).toBe(1);
  });
});

describe("karmaBlocksGang", () => {
  it("needs karma -54000 outside BitNode 2", () => {
    expect(karmaBlocksGang(-100, 10)).toBe(true);
    expect(karmaBlocksGang(-54000, 10)).toBe(false);
  });

  it("never blocks in BitNode 2", () => {
    expect(karmaBlocksGang(0, 2)).toBe(false);
  });
});

describe("nextMemberName", () => {
  it("takes the first unused name from the list", () => {
    expect(nextMemberName(new Set(["Clotho"]), ["Clotho", "Atropos"])).toBe("Atropos");
  });

  it("gives a fallen member's name to their replacement", () => {
    expect(nextMemberName(new Set(["Atropos"]), ["Clotho", "Atropos"])).toBe("Clotho");
  });

  it("falls back to Member-N once the list is used up", () => {
    expect(nextMemberName(new Set(["Clotho", "Atropos"]), ["Clotho", "Atropos"])).toBe("Member-2");
    expect(nextMemberName(new Set(["Clotho", "Member-1"]), ["Clotho"])).toBe("Member-2");
  });
});

describe("stateForNode", () => {
  it("starts fresh when the state is from another BitNode", () => {
    expect(stateForNode({ lastKnownMemberCount: 12, casualties: 0, nodeReset: 111 }, 222, 3)).toEqual({
      lastKnownMemberCount: 3,
      casualties: 0,
      nodeReset: 222,
    });
  });

  it("clears BN9's phantom casualties when no BitNode was recorded", () => {
    expect(stateForNode({ lastKnownMemberCount: 10, casualties: 12 }, 222, 10)).toEqual({ lastKnownMemberCount: 10, casualties: 0, nodeReset: 222 });
  });

  it("keeps the state within the same BitNode, or when the node is unknown", () => {
    const state = { lastKnownMemberCount: 10, casualties: 1, nodeReset: 222 };
    expect(stateForNode(state, 222, 9)).toBe(state);
    expect(stateForNode(state, undefined, 9)).toBe(state);
  });
});

describe("decideEquipmentPurchase maxItemCost", () => {
  it("skips items above the per-item cap even when affordable", () => {
    const candidates = [
      { member: "Clotho", name: "Rootkit", cost: 5e9 },
      { member: "Clotho", name: "Katana", cost: 1e9 },
    ];
    expect(decideEquipmentPurchase(1e12, 0, 1, candidates, 4e9)?.name).toBe("Katana");
    expect(decideEquipmentPurchase(1e12, 0, 1, [candidates[0]], 4e9)).toBeUndefined();
  });
});

describe("gang augmentations before equipment", () => {
  const candidates = [
    { member: "Clotho", name: "Katana", cost: 1e6 },
    { member: "Clotho", name: "Bionic Arms", cost: 5e8, augmentation: true },
  ];

  it("buys an affordable augmentation before cheaper equipment", () => {
    expect(decideEquipmentPurchase(1e12, 0, 1, candidates)?.name).toBe("Bionic Arms");
  });

  it("falls back to equipment when no augmentation is affordable", () => {
    expect(decideEquipmentPurchase(1e7, 0, 1, candidates)?.name).toBe("Katana");
  });

  it("skips regular equipment for members about to ascend, but not their augmentations", () => {
    const kept = skipEquipmentBeforeAscension(
      [...candidates, { member: "Atropos", name: "Katana", cost: 1e6 }],
      new Set(["Clotho"])
    );
    expect(kept.map((c) => `${c.member}:${c.name}`)).toEqual(["Clotho:Bionic Arms", "Atropos:Katana"]);
  });
});

describe("ascensionThreshold", () => {
  it("uses the high early bar until the gang is full", () => {
    expect(ascensionThreshold(10, 12, 1.1, 2)).toBe(2);
    expect(ascensionThreshold(12, 12, 1.1, 2)).toBe(1.1);
  });

  it("never goes below the normal bar", () => {
    expect(ascensionThreshold(10, 12, 1.1, 1.05)).toBe(1.1);
  });
});

describe("decideMemberTask never idles", () => {
  const policy = { minWantedPenalty: 0.9, wantedReductionFraction: 0.2 };
  const zero = (name: string) => ({ name, moneyGain: 0, wantedLevelGain: 0, respectGain: 0 });

  it("trains a member for whom nothing pays yet, instead of picking Unassigned", () => {
    const options = [zero("Unassigned"), zero("Mug People"), zero("Territory Warfare")];
    expect(decideMemberTask(0, 10, 1, policy, options, "Train Combat")).toBe("Train Combat");
  });

  it("never picks Unassigned or Territory Warfare even when they look best", () => {
    const options = [{ ...zero("Unassigned"), moneyGain: 5 }, { ...zero("Mug People"), moneyGain: 1 }];
    expect(decideMemberTask(0, 10, 1, policy, options, "Train Combat")).toBe("Mug People");
  });
});

describe("skipRecentlyAscended", () => {
  const item = (member: string, augmentation: boolean) => ({ member, name: augmentation ? "Bionic Arms" : "Baseball Bat", cost: 1e6, augmentation });
  it("holds regular equipment for a member who just ascended, not augmentations", () => {
    const recent = new Map([["Hercules", 1_000_000]]);
    const kept = skipRecentlyAscended([item("Hercules", false), item("Hercules", true), item("Ajax", false)], recent, 1_000_000 + 60_000, 20 * 60_000);
    expect(kept.map((c) => `${c.member}:${c.augmentation}`)).toEqual(["Hercules:true", "Ajax:false"]);
  });

  it("buys again once the cooldown has passed", () => {
    const recent = new Map([["Hercules", 0]]);
    expect(skipRecentlyAscended([item("Hercules", false)], recent, 21 * 60_000, 20 * 60_000)).toHaveLength(1);
  });
});

describe("gangFactionFor", () => {
  it("is the gang's faction, or the one it will be created with", () => {
    expect(gangFactionFor("Tetrads", ["Slum Snakes", "Tetrads"])).toBe("Tetrads");
    expect(gangFactionFor(undefined, ["Netburners", "Slum Snakes"])).toBe("Slum Snakes");
    expect(gangFactionFor(undefined, ["Netburners"])).toBeUndefined();
  });
});

describe("gangObjective", () => {
  it("works for respect until the roster is full, then money", () => {
    expect(gangObjective(3)).toBe("respect");
    expect(gangObjective(12)).toBe("money");
  });

  it("picks the most respect while recruiting", () => {
    const options = [
      { name: "Mug People", moneyGain: 5, wantedLevelGain: 0.1, respectGain: 1 },
      { name: "Terrorism", moneyGain: 0, wantedLevelGain: 0.5, respectGain: 9 },
    ];
    expect(decideMemberTask(0, 3, 1, { minWantedPenalty: 0.9, wantedReductionFraction: 0.2 }, options, "Train Combat", "respect")).toBe("Terrorism");
    expect(decideMemberTask(0, 3, 1, { minWantedPenalty: 0.9, wantedReductionFraction: 0.2 }, options, "Train Combat", "money")).toBe("Mug People");
  });
});
