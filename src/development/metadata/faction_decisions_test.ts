import { describe, expect, it } from "vitest";
import {
  AugmentationInfo,
  decideAugmentationPurchase,
  decideFactionsToJoin,
  decideInstallReady,
  decideWorkTarget,
  NEUROFLUX_GOVERNOR,
} from "development/metadata/faction_decisions";

const aug = (overrides: Partial<AugmentationInfo> = {}): AugmentationInfo => ({
  name: "Aug",
  faction: "CyberSec",
  price: 1000,
  repReq: 0,
  prereqs: [],
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
  it("buys the cheapest eligible augmentation within budget", () => {
    const catalog = [aug({ name: "Cheap", price: 100 }), aug({ name: "Pricey", price: 900 })];
    expect(decideAugmentationPurchase(1000, 0, 1, { CyberSec: 0 }, catalog, [])).toEqual({
      kind: "buy",
      faction: "CyberSec",
      augmentation: "Cheap",
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
