import { PlayerRequirement } from "@ns";
import { describe, expect, it } from "vitest";
import {
  AugmentationInfo,
  decideAugmentationPurchase,
  decideCrimeForKills,
  decideEligibilityStandDown,
  decideFactionsToJoin,
  decideInstallReady,
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
    expect(decideInstallReady({ kind: "none" }, ["Aug"])).toBe(true);
  });

  it("is false while there's still something affordable to buy", () => {
    expect(decideInstallReady({ kind: "buy", faction: "CyberSec", augmentation: "Aug" }, ["Aug"])).toBe(false);
  });

  it("is false when nothing has been purchased yet, even with nothing left to buy", () => {
    expect(decideInstallReady({ kind: "none" }, [])).toBe(false);
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
