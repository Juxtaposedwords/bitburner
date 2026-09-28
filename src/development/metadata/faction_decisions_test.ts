import { PlayerRequirement } from "@ns";
import { describe, expect, it } from "vitest";
import {
  AugmentationInfo,
  decideAugmentationPurchase,
  decideCrimeForKills,
  decideDonation,
  decideEligibilityStandDown,
  decideFactionsToJoin,
  decideInstallReady,
  trainingPaysOff,
  gangTrainingStat,
  pickKarmaCrime,
  onlyCombatLeft,
  catalogsFor,
  unmetMoneyRequirement,
  priorityFocus,
  favorPlan,
  favorPlanReady,
  repForFavor,
  wantedInviteFactions,
  redPillFocus,
  pendingAugmentations,
  bestWorkType,
  repSeriesId,
  decidePreInstall,
  decideWorkTarget,
  EligibilitySnapshot,
  evaluateRequirement,
  findBlockingRequirement,
  hasAnyCityFaction,
  NEUROFLUX_GOVERNOR,
  requirementToAction,
} from "development/metadata/faction_decisions";

const aug = (overrides: Partial<AugmentationInfo> = {}): AugmentationInfo => ({
  name: "Aug",
  faction: "CyberSec",
  price: 1000,
  repReq: 0,
  prereqs: [],
  ...overrides,
});

const snapshot = (overrides: Partial<EligibilitySnapshot> = {}): EligibilitySnapshot => ({
  money: 0,
  skills: { hacking: 0, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 },
  karma: 0,
  numPeopleKilled: 0,
  city: "Sector-12",
  jobs: {},
  companyReps: {},
  ...overrides,
});

describe("decideFactionsToJoin", () => {
  it("joins every invitation when no allowlist is set", () => {
    expect(decideFactionsToJoin(["CyberSec", "NiteSec"], [])).toEqual(["CyberSec", "NiteSec"]);
  });

  it("excludes factions already joined", () => {
    expect(decideFactionsToJoin(["CyberSec", "NiteSec"], ["CyberSec"])).toEqual(["NiteSec"]);
  });

  it("only joins factions on the allowlist when one is set", () => {
    expect(decideFactionsToJoin(["CyberSec", "NiteSec"], [], ["NiteSec"])).toEqual(["NiteSec"]);
  });

  it("returns an empty array when nothing new is invited", () => {
    expect(decideFactionsToJoin([], [])).toEqual([]);
  });
});

describe("decideWorkTarget", () => {
  it("works for The Red Pill's faction ahead of a smaller gap elsewhere", () => {
    const catalog = [
      aug({ name: "NeuroFlux Governor", faction: "Sector-12", repReq: 1000 }),
      aug({ name: "The Red Pill", faction: "Daedalus", repReq: 2.5e6 }),
    ];
    const reps = { "Sector-12": 990, Daedalus: 0 };

    expect(decideWorkTarget(["Sector-12", "Daedalus"], reps, catalog, [])).toBe("Daedalus");
  });

  it("goes back to the smallest gap once The Red Pill's rep is reached or it's owned", () => {
    const catalog = [
      aug({ name: "NeuroFlux Governor", faction: "Sector-12", repReq: 1000 }),
      aug({ name: "The Red Pill", faction: "Daedalus", repReq: 2.5e6 }),
    ];

    expect(decideWorkTarget(["Sector-12", "Daedalus"], { "Sector-12": 990, Daedalus: 2.5e6 }, catalog, [])).toBe("Sector-12");
    expect(decideWorkTarget(["Sector-12", "Daedalus"], { "Sector-12": 990, Daedalus: 0 }, catalog, ["The Red Pill"])).toBe("Sector-12");
  });

  it("picks the faction with the smallest positive reputation gap to its next wanted augmentation", () => {
    const catalog = [
      aug({ name: "Cheap", faction: "CyberSec", repReq: 100 }),
      aug({ name: "Expensive", faction: "NiteSec", repReq: 10000 }),
    ];
    const reps = { CyberSec: 90, NiteSec: 0 };

    expect(decideWorkTarget(["CyberSec", "NiteSec"], reps, catalog, [])).toBe("CyberSec");
  });

  it("skips a faction whose every augmentation is already owned", () => {
    const catalog = [aug({ name: "Owned", faction: "CyberSec", repReq: 100 })];
    expect(decideWorkTarget(["CyberSec"], { CyberSec: 0 }, catalog, ["Owned"])).toBeUndefined();
  });

  it("still considers NeuroFlux Governor even though it's in the owned list", () => {
    const catalog = [aug({ name: NEUROFLUX_GOVERNOR, faction: "CyberSec", repReq: 500 })];
    expect(decideWorkTarget(["CyberSec"], { CyberSec: 0 }, catalog, [NEUROFLUX_GOVERNOR])).toBe("CyberSec");
  });

  it("skips a faction whose reputation already meets every requirement (nothing left to work toward)", () => {
    const catalog = [aug({ name: "Aug", faction: "CyberSec", repReq: 100 })];
    expect(decideWorkTarget(["CyberSec"], { CyberSec: 100 }, catalog, [])).toBeUndefined();
  });

  it("returns undefined when no factions are joined", () => {
    expect(decideWorkTarget([], {}, [], [])).toBeUndefined();
  });
});

describe("decideAugmentationPurchase", () => {
  it("buys the most expensive eligible augmentation within budget - minimizes total spend across the whole batch (see module doc)", () => {
    const catalog = [aug({ name: "Cheap", price: 100 }), aug({ name: "Pricey", price: 900 })];
    expect(decideAugmentationPurchase(1000, 0, 1, { CyberSec: 0 }, catalog, [])).toEqual({
      kind: "buy",
      faction: "CyberSec",
      augmentation: "Pricey",
    });
  });

  it("never picks something over budget just because it's the most expensive - still bounded by affordability", () => {
    const catalog = [aug({ name: "Affordable", price: 400 }), aug({ name: "TooExpensive", price: 1_000_000 })];
    expect(decideAugmentationPurchase(1000, 0, 1, { CyberSec: 0 }, catalog, [])).toEqual({
      kind: "buy",
      faction: "CyberSec",
      augmentation: "Affordable",
    });
  });

  it("excludes an augmentation whose reputation requirement isn't met", () => {
    const catalog = [aug({ name: "NeedsRep", repReq: 1000 })];
    expect(decideAugmentationPurchase(1_000_000, 0, 1, { CyberSec: 0 }, catalog, [])).toEqual({ kind: "none" });
  });

  it("excludes an augmentation whose prereq isn't owned", () => {
    const catalog = [aug({ name: "NeedsPrereq", prereqs: ["Missing"] })];
    expect(decideAugmentationPurchase(1_000_000, 0, 1, { CyberSec: 0 }, catalog, [])).toEqual({ kind: "none" });
  });

  it("includes an augmentation once its prereq is owned", () => {
    const catalog = [aug({ name: "NeedsPrereq", prereqs: ["Have"] })];
    expect(decideAugmentationPurchase(1_000_000, 0, 1, { CyberSec: 0 }, catalog, ["Have"])).toEqual({
      kind: "buy",
      faction: "CyberSec",
      augmentation: "NeedsPrereq",
    });
  });

  it("excludes an already-owned non-repeatable augmentation", () => {
    const catalog = [aug({ name: "Owned" })];
    expect(decideAugmentationPurchase(1_000_000, 0, 1, { CyberSec: 0 }, catalog, ["Owned"])).toEqual({ kind: "none" });
  });

  it("still offers NeuroFlux Governor even though it's already owned", () => {
    const catalog = [aug({ name: NEUROFLUX_GOVERNOR, price: 500 })];
    expect(decideAugmentationPurchase(1_000_000, 0, 1, { CyberSec: 0 }, catalog, [NEUROFLUX_GOVERNOR])).toEqual({
      kind: "buy",
      faction: "CyberSec",
      augmentation: NEUROFLUX_GOVERNOR,
    });
  });

  it("respects reserveMoney and maxSpendFraction the same way decideNodeInvestment does", () => {
    const catalog = [aug({ name: "Aug", price: 600 })];
    // money=1000, reserve=500 -> budget capped at 500, can't afford 600.
    expect(decideAugmentationPurchase(1000, 500, 1, { CyberSec: 0 }, catalog, [])).toEqual({ kind: "none" });
  });

  it("returns none when nothing is eligible", () => {
    expect(decideAugmentationPurchase(1_000_000, 0, 1, {}, [], [])).toEqual({ kind: "none" });
  });
});

describe("decideInstallReady", () => {
  it("is true once nothing's left to buy and something purchased is waiting to be installed", () => {
    expect(decideInstallReady({ kind: "none" }, ["Aug"], 0)).toBe(true);
  });

  it("is false while there's still something affordable to buy", () => {
    expect(decideInstallReady({ kind: "buy", faction: "CyberSec", augmentation: "Aug" }, ["Aug"], 0)).toBe(false);
  });

  it("is false when nothing has been purchased yet, even with nothing left to buy", () => {
    expect(decideInstallReady({ kind: "none" }, [], 0)).toBe(false);
  });

  it("is false while a cash reserve is set, since an install would wipe the reserved cash", () => {
    expect(decideInstallReady({ kind: "none" }, ["Aug"], 100e9)).toBe(false);
  });
});

describe("evaluateRequirement", () => {
  it("evaluates a money requirement", () => {
    expect(evaluateRequirement({ type: "money", money: 100 }, snapshot({ money: 100 }))).toBe(true);
    expect(evaluateRequirement({ type: "money", money: 100 }, snapshot({ money: 99 }))).toBe(false);
  });

  it("evaluates a skills requirement across every listed stat", () => {
    const req: PlayerRequirement = { type: "skills", skills: { strength: 50, defense: 50 } };
    expect(evaluateRequirement(req, snapshot({ skills: { ...snapshot().skills, strength: 50, defense: 50 } }))).toBe(true);
    expect(evaluateRequirement(req, snapshot({ skills: { ...snapshot().skills, strength: 50, defense: 49 } }))).toBe(false);
  });

  it("treats karma as a ceiling - player's karma must be <= the requirement", () => {
    expect(evaluateRequirement({ type: "karma", karma: -90 }, snapshot({ karma: -90 }))).toBe(true);
    expect(evaluateRequirement({ type: "karma", karma: -90 }, snapshot({ karma: -89 }))).toBe(false);
  });

  it("evaluates numPeopleKilled", () => {
    expect(evaluateRequirement({ type: "numPeopleKilled", numPeopleKilled: 5 }, snapshot({ numPeopleKilled: 5 }))).toBe(true);
    expect(evaluateRequirement({ type: "numPeopleKilled", numPeopleKilled: 5 }, snapshot({ numPeopleKilled: 4 }))).toBe(false);
  });

  it("evaluates employedBy", () => {
    const req: PlayerRequirement = { type: "employedBy", company: "ECorp" };
    expect(evaluateRequirement(req, snapshot({ jobs: { ECorp: "Employee" } }))).toBe(true);
    expect(evaluateRequirement(req, snapshot({ jobs: {} }))).toBe(false);
  });

  it("evaluates companyReputation", () => {
    const req: PlayerRequirement = { type: "companyReputation", company: "ECorp", reputation: 400000 };
    expect(evaluateRequirement(req, snapshot({ companyReps: { ECorp: 400000 } }))).toBe(true);
    expect(evaluateRequirement(req, snapshot({ companyReps: { ECorp: 399999 } }))).toBe(false);
  });

  it("evaluates city", () => {
    const req: PlayerRequirement = { type: "city", city: "Aevum" };
    expect(evaluateRequirement(req, snapshot({ city: "Aevum" }))).toBe(true);
    expect(evaluateRequirement(req, snapshot({ city: "Sector-12" }))).toBe(false);
  });

  it("negates via not", () => {
    const req: PlayerRequirement = { type: "not", condition: { type: "employedBy", company: "Central Intelligence Agency" } };
    expect(evaluateRequirement(req, snapshot({ jobs: {} }))).toBe(true);
    expect(evaluateRequirement(req, snapshot({ jobs: { "Central Intelligence Agency": "Employee" } }))).toBe(false);
  });

  it("evaluates someCondition as OR - true if either branch passes", () => {
    const req: PlayerRequirement = {
      type: "someCondition",
      conditions: [{ type: "city", city: "Aevum" }, { type: "city", city: "Sector-12" }],
    };
    expect(evaluateRequirement(req, snapshot({ city: "Volhaven" }))).toBe(false);
    expect(evaluateRequirement(req, snapshot({ city: "Aevum" }))).toBe(true);
  });

  it("evaluates everyCondition as AND", () => {
    const req: PlayerRequirement = {
      type: "everyCondition",
      conditions: [{ type: "money", money: 100 }, { type: "karma", karma: -10 }],
    };
    expect(evaluateRequirement(req, snapshot({ money: 100, karma: -10 }))).toBe(true);
    expect(evaluateRequirement(req, snapshot({ money: 100, karma: 0 }))).toBe(false);
  });

  it("optimistically treats an unmodeled leaf type (e.g. jobTitle) as satisfied", () => {
    const req: PlayerRequirement = { type: "jobTitle", jobTitle: "Chief Executive Officer" };
    expect(evaluateRequirement(req, snapshot())).toBe(true);
  });
});

describe("findBlockingRequirement", () => {
  // Mirrors The Syndicate's real shape verbatim (getFactionInviteRequirements's own doc example).
  const syndicateRequirements: PlayerRequirement[] = [
    { type: "someCondition", conditions: [{ type: "city", city: "Aevum" }, { type: "city", city: "Sector-12" }] },
    { type: "not", condition: { type: "employedBy", company: "Central Intelligence Agency" } },
    { type: "not", condition: { type: "employedBy", company: "National Security Agency" } },
    { type: "money", money: 10000000 },
    { type: "skills", skills: { hacking: 200 } },
    { type: "skills", skills: { strength: 200 } },
    { type: "skills", skills: { defense: 200 } },
    { type: "skills", skills: { dexterity: 200 } },
    { type: "skills", skills: { agility: 200 } },
    { type: "karma", karma: -90 },
  ];

  it("finds the city gap first when in neither Aevum nor Sector-12", () => {
    const blocking = findBlockingRequirement(syndicateRequirements, snapshot({ city: "Volhaven" }));
    expect(blocking).toEqual({ type: "city", city: "Aevum" });
  });

  it("moves to the not(employedBy) gap once the city requirement is satisfied", () => {
    const blocking = findBlockingRequirement(
      syndicateRequirements,
      snapshot({ city: "Aevum", jobs: { "Central Intelligence Agency": "Employee" } })
    );
    expect(blocking).toEqual({ type: "not", condition: { type: "employedBy", company: "Central Intelligence Agency" } });
  });

  it("picks the combat stat with the LARGEST remaining gap among several unsatisfied skill entries, not the smallest", () => {
    const clearCity = snapshot({
      city: "Aevum",
      skills: { hacking: 200, strength: 150, defense: 195, dexterity: 0, agility: 200, charisma: 0, intelligence: 0 },
    });
    const blocking = findBlockingRequirement(syndicateRequirements, clearCity);
    // dexterity's gap (200) is larger than strength's (50) or defense's (5).
    expect(blocking).toEqual({ type: "skills", skills: { dexterity: 200 } });
  });

  it("returns undefined once every actionable requirement is satisfied, even though money alone remains open", () => {
    const almostThere = snapshot({
      city: "Aevum",
      skills: { hacking: 200, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 0, intelligence: 0 },
      karma: -90,
      money: 0, // still short - but money isn't actionable, so this shouldn't block anything.
    });
    expect(findBlockingRequirement(syndicateRequirements, almostThere)).toBeUndefined();
  });

  it("returns undefined when every unsatisfied entry is non-actionable (Silhouette-shaped: only jobTitle blocks)", () => {
    const requirements: PlayerRequirement[] = [
      { type: "jobTitle", jobTitle: "Chief Executive Officer" },
      { type: "money", money: 15000000 },
      { type: "karma", karma: -22 },
    ];
    expect(findBlockingRequirement(requirements, snapshot({ money: 15000000, karma: -22 }))).toBeUndefined();
  });
});

describe("requirementToAction", () => {
  it("maps city to travel", () => {
    expect(requirementToAction({ type: "city", city: "Aevum" }, "Business", snapshot())).toEqual({
      kind: "travel",
      city: "Aevum",
    });
  });

  it("maps employedBy to applyToCompany using the configured job field", () => {
    expect(requirementToAction({ type: "employedBy", company: "ECorp" }, "Business", snapshot())).toEqual({
      kind: "applyToCompany",
      company: "ECorp",
      field: "Business",
    });
  });

  it("maps companyReputation to workForCompany", () => {
    expect(requirementToAction({ type: "companyReputation", company: "ECorp", reputation: 400000 }, "Business", snapshot())).toEqual({
      kind: "workForCompany",
      company: "ECorp",
    });
  });

  it("maps not(employedBy) to quitJob", () => {
    const req: PlayerRequirement = { type: "not", condition: { type: "employedBy", company: "Central Intelligence Agency" } };
    expect(requirementToAction(req, "Business", snapshot())).toEqual({ kind: "quitJob", company: "Central Intelligence Agency" });
  });

  it("maps numPeopleKilled to commitCrime with an unresolved crime name", () => {
    expect(requirementToAction({ type: "numPeopleKilled", numPeopleKilled: 5 }, "Business", snapshot())).toEqual({
      kind: "commitCrime",
      crime: "",
    });
  });

  it("maps a single combat-skill entry to gymWorkout for that stat", () => {
    const req: PlayerRequirement = { type: "skills", skills: { strength: 200 } };
    expect(requirementToAction(req, "Business", snapshot())).toEqual({ kind: "gymWorkout", stat: "strength" });
  });

  it("picks the LARGEST gap, not the smallest, when a single skills entry somehow lists multiple combat stats", () => {
    const req: PlayerRequirement = { type: "skills", skills: { strength: 50, agility: 300 } };
    const action = requirementToAction(
      req,
      "Business",
      snapshot({ skills: { hacking: 0, strength: 0, defense: 0, dexterity: 0, agility: 0, charisma: 0, intelligence: 0 } })
    );
    expect(action).toEqual({ kind: "gymWorkout", stat: "agility" });
  });
});

describe("decideCrimeForKills", () => {
  it("picks the crime maximizing kills among those clearing the success-chance floor", () => {
    const candidates = [
      { crime: "Mug", kills: 0, successChance: 0.9 },
      { crime: "Homicide", kills: 1, successChance: 0.6 },
      { crime: "Assassination", kills: 1, successChance: 0.8 },
    ];
    expect(decideCrimeForKills(candidates, 0.5)).toBe("Homicide");
  });

  it("excludes a high-kill candidate below the success-chance floor", () => {
    const candidates = [
      { crime: "Homicide", kills: 1, successChance: 0.05 },
      { crime: "Assassination", kills: 1, successChance: 0.8 },
    ];
    expect(decideCrimeForKills(candidates, 0.5)).toBe("Assassination");
  });

  it("returns undefined when nothing clears the floor", () => {
    expect(decideCrimeForKills([{ crime: "Homicide", kills: 1, successChance: 0.1 }], 0.5)).toBeUndefined();
  });
});

describe("decideEligibilityStandDown", () => {
  it("is false below the attempt cap", () => {
    expect(decideEligibilityStandDown(5, 100)).toBe(false);
  });

  it("is true once attempts reach the cap", () => {
    expect(decideEligibilityStandDown(100, 100)).toBe(true);
  });
});

describe("hasAnyCityFaction", () => {
  it("is false when none of the 6 city factions are joined", () => {
    expect(hasAnyCityFaction(["CyberSec", "Netburners"])).toBe(false);
  });

  it("is true once any one city faction is joined", () => {
    expect(hasAnyCityFaction(["CyberSec", "Sector-12"])).toBe(true);
  });
});

describe("decidePreInstall", () => {
  const buy = { kind: "buy" as const, faction: "CyberSec", augmentation: "Neurotrainer I" };

  it("spends any remaining affordable cash before anything else", () => {
    expect(decidePreInstall(buy, 3)).toEqual(buy);
  });

  it("winds down (liquidate stock) when nothing is affordable but stock is still held", () => {
    expect(decidePreInstall({ kind: "none" }, 3)).toEqual({ kind: "wind-down" });
  });

  it("installs only with nothing affordable and no stock held", () => {
    expect(decidePreInstall({ kind: "none" }, 0)).toEqual({ kind: "install" });
  });
});

describe("decideDonation", () => {
  // $1 of donation per point of rep, to keep the arithmetic readable.
  const perRep = (rep: number) => rep;
  const donatable = new Set(["Sector-12", "CyberSec"]);

  it("donates exactly the rep gap for an augmentation that's otherwise affordable", () => {
    const catalog = [aug({ name: "Aug", faction: "Sector-12", price: 100, repReq: 1000 })];
    expect(decideDonation(10_000, 0, 1, { "Sector-12": 400 }, catalog, [], donatable, perRep)).toEqual({
      kind: "donate",
      faction: "Sector-12",
      augmentation: "Aug",
      amount: 600,
    });
  });

  it("skips factions that can't take donations (not enough favor, or the gang faction)", () => {
    const catalog = [aug({ name: "Aug", faction: "BitRunners", price: 100, repReq: 1000 })];
    expect(decideDonation(10_000, 0, 1, { BitRunners: 0 }, catalog, [], donatable, perRep)).toEqual({ kind: "none" });
  });

  it("needs the donation AND the augmentation's price to fit the budget - never burns money on rep it can't use", () => {
    const catalog = [aug({ name: "Aug", faction: "Sector-12", price: 500, repReq: 1000 })];
    // gap 1000 + price 500 = 1500 > 1200
    expect(decideDonation(1200, 0, 1, { "Sector-12": 0 }, catalog, [], donatable, perRep)).toEqual({ kind: "none" });
  });

  it("respects reserveMoney and maxSpendFraction like the normal purchase path", () => {
    const catalog = [aug({ name: "Aug", faction: "Sector-12", price: 100, repReq: 200 })];
    // budget = min(1000 - 0, 1000 * 0.2) = 200 < 200 + 100
    expect(decideDonation(1000, 0, 0.2, { "Sector-12": 0 }, catalog, [], donatable, perRep)).toEqual({ kind: "none" });
  });

  it("ignores augmentations whose rep is already met - the normal purchase path buys those", () => {
    const catalog = [aug({ name: "Aug", faction: "Sector-12", price: 100, repReq: 100 })];
    expect(decideDonation(10_000, 0, 1, { "Sector-12": 100 }, catalog, [], donatable, perRep)).toEqual({ kind: "none" });
  });

  it("skips already-owned augmentations and ones with missing prereqs", () => {
    const catalog = [
      aug({ name: "Owned", faction: "Sector-12", repReq: 100 }),
      aug({ name: "NeedsPrereq", faction: "Sector-12", repReq: 100, prereqs: ["Missing"] }),
    ];
    expect(decideDonation(1e9, 0, 1, { "Sector-12": 0 }, catalog, ["Owned"], donatable, perRep)).toEqual({ kind: "none" });
  });

  it("prefers the most expensive qualifying augmentation, same as the purchase path", () => {
    const catalog = [
      aug({ name: "Cheap", faction: "Sector-12", price: 100, repReq: 10 }),
      aug({ name: "Pricey", faction: "Sector-12", price: 900, repReq: 10 }),
    ];
    const decision = decideDonation(10_000, 0, 1, { "Sector-12": 0 }, catalog, [], donatable, perRep);
    expect(decision).toMatchObject({ kind: "donate", augmentation: "Pricey" });
  });

  it("for NeuroFlux Governor offered by several donatable factions, donates to the one closest to the requirement", () => {
    const catalog = [
      aug({ name: NEUROFLUX_GOVERNOR, faction: "Sector-12", price: 100, repReq: 1000 }),
      aug({ name: NEUROFLUX_GOVERNOR, faction: "CyberSec", price: 100, repReq: 1000 }),
    ];
    const decision = decideDonation(10_000, 0, 1, { "Sector-12": 100, CyberSec: 900 }, catalog, [NEUROFLUX_GOVERNOR], donatable, perRep);
    expect(decision).toEqual({ kind: "donate", faction: "CyberSec", augmentation: NEUROFLUX_GOVERNOR, amount: 100 });
  });
});

describe("repSeriesId", () => {
  it("slugs faction names into series ids", () => {
    expect(repSeriesId("The Black Hand")).toBe("gauge/rep_the_black_hand");
    expect(repSeriesId("Sector-12")).toBe("gauge/rep_sector_12");
    expect(repSeriesId("Daedalus")).toBe("gauge/rep_daedalus");
  });
});

describe("bestWorkType", () => {
  it("picks the work type with the most rep", () => {
    expect(bestWorkType(["hacking", "field", "security"], { hacking: 2900, field: 4100, security: 3000 })).toBe("field");
  });

  it("keeps listing order on a tie", () => {
    expect(bestWorkType(["hacking", "field"], { hacking: 100, field: 100 })).toBe("hacking");
  });

  it("is undefined with nothing offered", () => {
    expect(bestWorkType([], {})).toBeUndefined();
  });
});

describe("pendingAugmentations", () => {
  it("counts a queued NeuroFlux Governor even when one is already installed", () => {
    expect(pendingAugmentations(["NeuroFlux Governor", "Aug A", "NeuroFlux Governor"], ["NeuroFlux Governor", "Aug A"])).toEqual(["NeuroFlux Governor"]);
  });

  it("returns every queued augmentation not yet installed", () => {
    expect(pendingAugmentations(["Aug A", "Aug B"], ["Aug A"])).toEqual(["Aug B"]);
  });

  it("is empty with nothing queued", () => {
    expect(pendingAugmentations(["Aug A", "NeuroFlux Governor"], ["Aug A", "NeuroFlux Governor"])).toEqual([]);
  });
});

describe("redPillFocus", () => {
  const catalog = [
    aug({ name: "NeuroFlux Governor", faction: "Sector-12", price: 1e9, repReq: 674119 }),
    aug({ name: "The Red Pill", faction: "Daedalus", price: 0, repReq: 2.5e6 }),
  ];

  it("focuses on The Red Pill once its faction takes donations", () => {
    expect(redPillFocus(catalog, { Daedalus: 1000 }, [], new Set(["Daedalus", "Sector-12"]))?.name).toBe("The Red Pill");
  });

  it("focuses on it once its rep is met, even without donations", () => {
    expect(redPillFocus(catalog, { Daedalus: 2.5e6 }, [], new Set())?.name).toBe("The Red Pill");
  });

  it("doesn't hold spending while it's only reachable by grinding", () => {
    expect(redPillFocus(catalog, { Daedalus: 1000 }, [], new Set(["Sector-12"]))).toBeUndefined();
  });

  it("stops once it's owned", () => {
    expect(redPillFocus(catalog, { Daedalus: 2.5e6 }, ["The Red Pill"], new Set(["Daedalus"]))).toBeUndefined();
  });

  it("makes the donation go to The Red Pill instead of a pricier NeuroFlux", () => {
    const focus = redPillFocus(catalog, { Daedalus: 1000, "Sector-12": 0 }, [], new Set(["Daedalus", "Sector-12"]));
    const decision = decideDonation(1e13, 0, 0.9, { Daedalus: 1000, "Sector-12": 0 }, focus ? [focus] : catalog, [], new Set(["Daedalus", "Sector-12"]), (rep) => rep * 258e3);
    expect(decision).toMatchObject({ kind: "donate", faction: "Daedalus", augmentation: "The Red Pill" });
  });
});

// Bitburner's favor curve: rep for `favor` = 25,000 * (1.02^favor - 1).
const favorToRep = (favor: number): number => 25000 * (Math.pow(1.02, favor) - 1);

describe("repForFavor", () => {
  it("is the rep between today's favor and the target", () => {
    expect(repForFavor(0, 150, favorToRep)).toBeCloseTo(favorToRep(150));
    expect(repForFavor(100, 150, favorToRep)).toBeCloseTo(favorToRep(150) - favorToRep(100));
  });

  it("is 0 once the favor is already there", () => {
    expect(repForFavor(160, 150, favorToRep)).toBe(0);
  });
});

describe("favorPlan", () => {
  const catalog = [
    aug({ name: "QLink", faction: "Illuminati", repReq: 1.875e6 }),
    aug({ name: "SPTN-97 Gene Modification", faction: "The Covenant", repReq: 1.25e6 }),
    aug({ name: "Cheap", faction: "CyberSec", repReq: 10000 }),
    aug({ name: "NeuroFlux Governor", faction: "Sector-12", repReq: 2.5e6 }),
  ];
  const joined = ["Illuminati", "The Covenant", "CyberSec", "Sector-12"];
  const favors = { Illuminati: 0, "The Covenant": 0, CyberSec: 0, "Sector-12": 0 };

  it("plans favor where the augmentation needs more rep than favor does", () => {
    const plan = favorPlan(joined, { Illuminati: 1000, "The Covenant": 500000 }, favors, catalog, [], 150, favorToRep);
    expect(plan.map((e) => e.faction)).toEqual(["Illuminati", "The Covenant"]);
    expect(plan[0]).toMatchObject({ augmentation: "QLink", rep: 1000 });
    expect(plan[0].target).toBeCloseTo(favorToRep(150));
  });

  it("skips cheap augmentations, NeuroFlux, owned ones, and factions already at donation favor", () => {
    const plan = favorPlan(joined, {}, { ...favors, Illuminati: 150 }, catalog, ["SPTN-97 Gene Modification"], 150, favorToRep);
    expect(plan).toEqual([]);
  });

  it("is ready only once every planned faction reached its target", () => {
    const plan = favorPlan(joined, { Illuminati: 500000, "The Covenant": 100 }, favors, catalog, [], 150, favorToRep);
    expect(favorPlanReady(plan)).toBe(false);
    expect(favorPlanReady(plan.map((e) => ({ ...e, rep: e.target })))).toBe(true);
    expect(favorPlanReady([])).toBe(false);
  });
});

describe("decideWorkTarget with a favor plan", () => {
  const catalog = [
    aug({ name: "QLink", faction: "Illuminati", repReq: 1.875e6 }),
    aug({ name: "SPTN-97 Gene Modification", faction: "The Covenant", repReq: 1.25e6 }),
    aug({ name: "NeuroFlux Governor", faction: "Sector-12", repReq: 1000 }),
  ];
  const joined = ["Illuminati", "The Covenant", "Sector-12"];

  it("works the planned faction closest to its target, ahead of a smaller gap elsewhere", () => {
    const plan = [
      { faction: "Illuminati", augmentation: "QLink", rep: 100000, target: 462000 },
      { faction: "The Covenant", augmentation: "SPTN-97 Gene Modification", rep: 400000, target: 462000 },
    ];
    expect(decideWorkTarget(joined, { "Sector-12": 990 }, catalog, [], plan)).toBe("The Covenant");
  });

  it("moves on once a planned faction reaches its target", () => {
    const plan = [
      { faction: "Illuminati", augmentation: "QLink", rep: 100000, target: 462000 },
      { faction: "The Covenant", augmentation: "SPTN-97 Gene Modification", rep: 462000, target: 462000 },
    ];
    expect(decideWorkTarget(joined, { "Sector-12": 990 }, catalog, [], plan)).toBe("Illuminati");
  });
});

describe("wantedInviteFactions", () => {
  const offered = {
    Illuminati: ["QLink", "NeuroFlux Governor"],
    "The Covenant": ["SPTN-97 Gene Modification"],
    Daedalus: ["The Red Pill", "NeuroFlux Governor"],
  };

  it("lists unjoined factions still selling something wanted", () => {
    expect(wantedInviteFactions(["Illuminati", "The Covenant", "Daedalus"], ["The Covenant"], offered, ["The Red Pill"])).toEqual(["Illuminati"]);
  });

  it("ignores a faction offering only NeuroFlux and owned augmentations", () => {
    expect(wantedInviteFactions(["Daedalus"], [], offered, ["The Red Pill"])).toEqual([]);
  });
});

describe("priorityFocus", () => {
  const qlink = aug({ name: "QLink", faction: "Illuminati", price: 25e12, repReq: 1.875e6, stats: { hacking: 1.75 } });
  const sptn = aug({ name: "SPTN-97 Gene Modification", faction: "The Covenant", price: 4.9e9, repReq: 1.25e6, stats: { hacking: 1.15 } });
  const combat = aug({ name: "Graphene Bone Lacings", faction: "The Covenant", price: 30e12, repReq: 1e6, stats: { strength: 1.7 } });
  const nfg = aug({ name: "NeuroFlux Governor", faction: "Sector-12", price: 3.7e9, repReq: 2.5e6, stats: { hacking: 1.01 } });
  const catalog = [qlink, sptn, combat, nfg];
  const focus = ["hacking", "hacking_exp"];
  const donatable = new Set(["Illuminati", "The Covenant", "Sector-12"]);

  it("picks the most expensive reachable augmentation in focus, holding cheaper ones", () => {
    expect(priorityFocus(catalog, {}, [], donatable, focus)?.name).toBe("QLink");
  });

  it("moves to the next once it's owned", () => {
    expect(priorityFocus(catalog, {}, ["QLink"], donatable, focus)?.name).toBe("SPTN-97 Gene Modification");
  });

  it("skips augmentations that are unreachable this cycle", () => {
    expect(priorityFocus(catalog, { "The Covenant": 1.25e6 }, [], new Set(), focus)?.name).toBe("SPTN-97 Gene Modification");
  });

  it("never holds for NeuroFlux, and ignores augmentations outside the focus", () => {
    expect(priorityFocus(catalog, {}, ["QLink", "SPTN-97 Gene Modification"], donatable, focus)).toBeUndefined();
  });

  it("puts The Red Pill first", () => {
    const redPill = aug({ name: "The Red Pill", faction: "Daedalus", price: 0, repReq: 2.5e6 });
    expect(priorityFocus([...catalog, redPill], {}, [], new Set([...donatable, "Daedalus"]), focus)?.name).toBe("The Red Pill");
  });

  it("with no focus, only The Red Pill counts", () => {
    expect(priorityFocus(catalog, {}, [], donatable, [])).toBeUndefined();
  });
});

describe("unmetMoneyRequirement", () => {
  it("returns the largest unmet cash requirement, including inside everyCondition", () => {
    const reqs: PlayerRequirement[] = [
      { type: "money", money: 75e9 },
      { type: "everyCondition", conditions: [{ type: "money", money: 150e9 }] },
    ];
    expect(unmetMoneyRequirement(reqs, snapshot({ money: 10e9 }))).toBe(150e9);
  });

  it("is 0 once cash covers it", () => {
    expect(unmetMoneyRequirement([{ type: "money", money: 75e9 }], snapshot({ money: 80e9 }))).toBe(0);
  });
});

describe("catalogsFor", () => {
  const nfgS12 = aug({ name: "NeuroFlux Governor", faction: "Sector-12" });
  const nfgIllum = aug({ name: "NeuroFlux Governor", faction: "Illuminati" });
  const qlink = aug({ name: "QLink", faction: "Illuminati" });
  const cashRoot = aug({ name: "CashRoot Starter Kit", faction: "Sector-12" });
  const catalog = [nfgS12, nfgIllum, qlink, cashRoot];

  it("never has NeuroFlux in regular buying, donating, or work targets", () => {
    expect(catalogsFor(catalog, []).regular.map((a) => a.name)).toEqual(["QLink", "CashRoot Starter Kit"]);
  });

  it("allows NeuroFlux before an install only at factions with nothing else left", () => {
    const { preInstall } = catalogsFor(catalog, ["CashRoot Starter Kit"]);
    expect(preInstall.filter((a) => a.name === "NeuroFlux Governor").map((a) => a.faction)).toEqual(["Sector-12"]);
  });

  it("lets Illuminati's NeuroFlux in once QLink is owned", () => {
    const { preInstall } = catalogsFor(catalog, ["CashRoot Starter Kit", "QLink"]);
    expect(preInstall.filter((a) => a.name === "NeuroFlux Governor").map((a) => a.faction)).toEqual(["Sector-12", "Illuminati"]);
  });

  it("means normal buying never picks NeuroFlux, even when it's the only affordable one", () => {
    const { regular } = catalogsFor([aug({ name: "NeuroFlux Governor", faction: "Sector-12", price: 1, repReq: 0 })], []);
    expect(decideAugmentationPurchase(1e15, 0, 1, { "Sector-12": 1e9 }, regular, [])).toEqual({ kind: "none" });
  });

  it("means NeuroFlux rep gaps no longer pick the work target", () => {
    const list = [aug({ name: "NeuroFlux Governor", faction: "Sector-12", repReq: 1000 }), aug({ name: "QLink", faction: "Illuminati", repReq: 1.875e6 })];
    expect(decideWorkTarget(["Sector-12", "Illuminati"], { "Sector-12": 999 }, catalogsFor(list, []).regular, [])).toBe("Illuminati");
  });
});

describe("onlyCombatLeft", () => {
  const reqs: PlayerRequirement[] = [
    { type: "money", money: 150e9 },
    { type: "skills", skills: { hacking: 1500 } },
    { type: "skills", skills: { strength: 1200 } },
  ];

  it("is false while money or hacking are still short", () => {
    expect(onlyCombatLeft(reqs, snapshot({ money: 1000 }))).toBe(false);
  });

  it("is true once only combat is short", () => {
    const s = snapshot({ money: 200e9 });
    s.skills.hacking = 2000;
    expect(onlyCombatLeft(reqs, s)).toBe(true);
  });
});

describe("pickKarmaCrime", () => {
  const homicide = { crime: "Homicide", karma: 3, timeMs: 3000 };
  const mug = { crime: "Mug", karma: 0.25, timeMs: 4000 };

  it("prefers a safer crime while the big one mostly fails", () => {
    expect(pickKarmaCrime([{ ...homicide, successChance: 0.05 }, { ...mug, successChance: 0.9 }])).toBe("Mug");
  });

  it("switches to Homicide once it succeeds often enough", () => {
    expect(pickKarmaCrime([{ ...homicide, successChance: 0.6 }, { ...mug, successChance: 1 }])).toBe("Homicide");
  });

  it("is undefined when nothing can succeed", () => {
    expect(pickKarmaCrime([{ ...homicide, successChance: 0 }])).toBeUndefined();
  });
});

describe("gangTrainingStat", () => {
  const skills = { hacking: 100, strength: 40, defense: 55, dexterity: 30, agility: 45, charisma: 1, intelligence: 0 };

  it("trains the weakest combat stat while the crime fails too often", () => {
    expect(gangTrainingStat(0.5, 0.8, skills)).toBe("dexterity");
  });

  it("goes back to crime once the chance is high enough", () => {
    expect(gangTrainingStat(0.85, 0.8, skills)).toBeUndefined();
  });

  it("with the formulas, trains the stat that raises the chance most, not the weakest", () => {
    const boosted = { strength: 0.62, defense: 0.6, dexterity: 0.52, agility: 0.51 };
    expect(gangTrainingStat(0.5, 0.8, skills, (stat) => boosted[stat])).toBe("strength");
  });
});

describe("trainingPaysOff", () => {
  // Homicide: 3 karma per success, 3s.
  it("trains when a short stint raises the rate a lot", () => {
    expect(trainingPaysOff(53000, 3, 3000, 0.5, 0.6, 10 * 60_000)).toBe(true);
  });

  it("commits the crime when training takes longer than it saves", () => {
    expect(trainingPaysOff(53000, 3, 3000, 0.5, 0.51, 10 * 60 * 60_000)).toBe(false);
  });

  it("commits the crime once the goal is close", () => {
    expect(trainingPaysOff(100, 3, 3000, 0.5, 0.6, 10 * 60_000)).toBe(false);
  });
});
