import { describe, expect, it } from "vitest";
import { decideHashSpend, decideNodeInvestment, hashCapacityBound, pickHashUpgrade, prioritizeForActivity } from "development/metadata/hacknet_decisions";

describe("decideNodeInvestment", () => {
  it("buys a new node when it's the cheapest affordable option", () => {
    const { decision } = decideNodeInvestment(1000, 0, 1, 100, false, []);

    expect(decision).toEqual({ kind: "buyNode" });
  });

  it("picks the cheapest affordable upgrade over a more expensive new node", () => {
    const { decision } = decideNodeInvestment(
      1000,
      0,
      1,
      500,
      false,
      [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: 50, ramCost: 400, coreCost: 300 }]
    );

    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "level" });
  });

  it("never proposes buying a node once atMaxNodes is true", () => {
    const { decision } = decideNodeInvestment(1000, 0, 1, 1, true, []);

    expect(decision).toEqual({ kind: "none" });
  });

  it("returns none when nothing is affordable", () => {
    const { decision } = decideNodeInvestment(
      10,
      0,
      1,
      1000,
      false,
      [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: 500, ramCost: 500, coreCost: 500 }]
    );

    expect(decision).toEqual({ kind: "none" });
  });

  it("respects reserveMoney as an absolute floor never spent below", () => {
    // 1000 money, 950 reserved -> only 50 spendable, node costs 100.
    const { decision } = decideNodeInvestment(1000, 950, 1, 100, false, []);

    expect(decision).toEqual({ kind: "none" });
  });

  it("respects maxSpendFraction as a relative throttle even with no reserve", () => {
    // 1000 money, fraction 0.05 -> only 50 spendable, node costs 100.
    const { decision } = decideNodeInvestment(1000, 0, 0.05, 100, false, []);

    expect(decision).toEqual({ kind: "none" });
  });

  it("uses the tighter of reserveMoney and maxSpendFraction", () => {
    // Fraction allows 500, reserve only allows 100 - reserve wins.
    const { decision } = decideNodeInvestment(1000, 900, 0.5, 150, false, []);

    expect(decision).toEqual({ kind: "none" });
  });

  it("excludes cache-upgrade candidates when cacheCost is omitted (plain Hacknet Node)", () => {
    const { decision } = decideNodeInvestment(
      1000,
      0,
      1,
      1000,
      true,
      [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: 900, ramCost: 900, coreCost: 900 }]
    );

    // Only real candidates (level/ram/core, all 900) are considered; a
    // stray cache candidate would have been cheaper and won if included.
    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "level" });
  });

  it("considers a cache-upgrade candidate when cacheCost is provided (Hacknet Server)", () => {
    const { decision } = decideNodeInvestment(
      1000,
      0,
      1,
      1000,
      true,
      [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: 900, ramCost: 900, coreCost: 900, cacheCost: 10 }]
    );

    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "cache" });
  });

  it("treats an Infinity cost (already maxed) as unaffordable rather than picking it", () => {
    const { decision } = decideNodeInvestment(
      1_000_000,
      0,
      1,
      1_000_000,
      true,
      [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: Infinity, ramCost: Infinity, coreCost: Infinity }]
    );

    expect(decision).toEqual({ kind: "none" });
  });

  describe("diagnostic fields (for logging why a tick did nothing)", () => {
    it("reports the computed budget alongside the decision", () => {
      const { budget } = decideNodeInvestment(1000, 200, 0.5, Infinity, true, []);

      expect(budget).toBe(500); // min(1000-200, 1000*0.5) = min(800, 500) = 500
    });

    it("reports the cheapest candidate's cost even when it isn't affordable", () => {
      const { bestCandidate, decision, candidateCount } = decideNodeInvestment(
        10,
        0,
        1,
        999_999,
        false,
        [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: 500_000, ramCost: 500_000, coreCost: 500_000 }]
      );

      expect(bestCandidate).toEqual({ cost: 500_000, decision: { kind: "upgrade", index: 0, upgrade: "level" } });
      expect(candidateCount).toBe(4); // buyNode + level/ram/core (no cache - plain node)
      expect(decision).toEqual({ kind: "none" });
    });

    it("reports candidateCount of 0 and an undefined bestCandidate when nothing was even considered", () => {
      const { bestCandidate, candidateCount } = decideNodeInvestment(1000, 0, 1, Infinity, true, []);

      expect(bestCandidate).toBeUndefined();
      expect(candidateCount).toBe(0);
    });
  });

  describe("ROI mode (gainRate provided - requires Formulas.exe)", () => {
    it("picks the higher-ROI candidate even when a lower-ROI one is cheaper", () => {
      const node = { index: 0, level: 1, ram: 1, cores: 1, levelCost: 50, ramCost: 200, coreCost: Infinity };
      // level upgrade: delta 1 (11-10), ROI 1/50 = 0.02
      // ram upgrade: delta 100 (110-10), ROI 100/200 = 0.5 - wins despite costing more
      const gainRate = (level: number, ram: number, cores: number): number => {
        if (level === 1 && ram === 1 && cores === 1) return 10;
        if (level === 2 && ram === 1 && cores === 1) return 11;
        if (level === 1 && ram === 2 && cores === 1) return 110;
        return 10;
      };

      const { decision } = decideNodeInvestment(10_000, 0, 1, Infinity, true, [node], gainRate);

      expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "ram" });
    });

    it("without gainRate, the same case falls back to cheapest-first and picks differently", () => {
      const node = { index: 0, level: 1, ram: 1, cores: 1, levelCost: 50, ramCost: 200, coreCost: Infinity };

      const { decision } = decideNodeInvestment(10_000, 0, 1, Infinity, true, [node]);

      expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "level" });
    });

    it("scores buyNode's ROI using gainRate(1, 1, 1) against a zero production baseline", () => {
      const gainRate = (level: number, ram: number, cores: number): number => (level === 1 && ram === 1 && cores === 1 ? 100 : 0);

      const { decision, bestCandidate } = decideNodeInvestment(10_000, 0, 1, 50, false, [], gainRate);

      expect(decision).toEqual({ kind: "buyNode" });
      expect(bestCandidate).toEqual({ cost: 50, decision: { kind: "buyNode" } });
    });

    it("never proposes a cache upgrade in ROI mode, even when it would be the cheapest option", () => {
      const node = { index: 0, level: 1, ram: 1, cores: 1, levelCost: Infinity, ramCost: Infinity, coreCost: Infinity, cacheCost: 1 };
      const gainRate = (): number => 10;

      const { decision, candidateCount } = decideNodeInvestment(10_000, 0, 1, Infinity, true, [node], gainRate);

      expect(decision).toEqual({ kind: "none" });
      expect(candidateCount).toBe(0);
    });
  });
});

describe("pickHashUpgrade", () => {
  it("picks the first affordable name in priority order", () => {
    const upgrade = pickHashUpgrade(
      ["Reduce Minimum Security", "Sell for Money"],
      100,
      { "Reduce Minimum Security": 50, "Sell for Money": 4 }
    );

    expect(upgrade).toBe("Reduce Minimum Security");
  });

  it("skips an unaffordable higher-priority name for the next affordable one", () => {
    const upgrade = pickHashUpgrade(
      ["Reduce Minimum Security", "Sell for Money"],
      10,
      { "Reduce Minimum Security": 50, "Sell for Money": 4 }
    );

    expect(upgrade).toBe("Sell for Money");
  });

  it("skips a name with no known cost (unrecognized/typo'd in config)", () => {
    const upgrade = pickHashUpgrade(["Nonexistent Upgrade", "Sell for Money"], 10, { "Sell for Money": 4 });

    expect(upgrade).toBe("Sell for Money");
  });

  it("returns undefined when nothing in the priority list is affordable", () => {
    const upgrade = pickHashUpgrade(["Sell for Money"], 1, { "Sell for Money": 4 });

    expect(upgrade).toBeUndefined();
  });

  it("returns undefined for an empty priority list", () => {
    expect(pickHashUpgrade([], 100, { "Sell for Money": 4 })).toBeUndefined();
  });
});

describe("decideHashSpend", () => {
  const priority = ["Improve Studying", "Improve Gym Training"];
  const costs = { "Improve Studying": 100, "Improve Gym Training": 60, "Sell for Money": 4 };

  it("buys the first affordable priority upgrade", () => {
    expect(decideHashSpend(priority, 150, 1000, costs, "Sell for Money", 0.9)).toEqual({ upgrade: "Improve Studying", reason: "priority" });
  });

  it("falls through to a cheaper priority upgrade", () => {
    expect(decideHashSpend(priority, 80, 1000, costs, "Sell for Money", 0.9)).toEqual({ upgrade: "Improve Gym Training", reason: "priority" });
  });

  it("holds hashes below the drain threshold when no priority upgrade is affordable", () => {
    expect(decideHashSpend(priority, 50, 1000, costs, "Sell for Money", 0.9)).toBeUndefined();
  });

  it("drains near capacity when no priority upgrade is affordable", () => {
    const expensive = { ...costs, "Improve Studying": 5000, "Improve Gym Training": 5000 };
    expect(decideHashSpend(priority, 950, 1000, expensive, "Sell for Money", 0.9)).toEqual({ upgrade: "Sell for Money", reason: "drain" });
  });

  it("never drains through the priority list, even if listed there", () => {
    expect(decideHashSpend(["Sell for Money"], 50, 1000, costs, "Sell for Money", 0.9)).toBeUndefined();
  });

  it("does not drain without hash capacity", () => {
    expect(decideHashSpend([], 50, 0, costs, "Sell for Money", 0)).toBeUndefined();
  });
});

describe("hashCapacityBound", () => {
  const priority = ["Improve Studying", "Improve Gym Training"];

  it("is true when every priority upgrade costs more than the pre-drain threshold", () => {
    expect(hashCapacityBound(priority, { "Improve Studying": 1000, "Improve Gym Training": 950 }, 1000, 0.9)).toBe(true);
  });

  it("is false when any priority upgrade still fits", () => {
    expect(hashCapacityBound(priority, { "Improve Studying": 1000, "Improve Gym Training": 800 }, 1000, 0.9)).toBe(false);
  });

  it("is false with no recognized priority upgrades", () => {
    expect(hashCapacityBound(priority, {}, 1000, 0.9)).toBe(false);
  });
});

describe("decideNodeInvestment needCapacity", () => {
  const nodes = [
    { index: 0, level: 10, ram: 8, cores: 2, levelCost: 10, ramCost: 10, coreCost: 10, cacheCost: 500 },
    { index: 1, level: 10, ram: 8, cores: 2, levelCost: 10, ramCost: 10, coreCost: 10, cacheCost: 300 },
  ];
  const gainRate = (level: number, ram: number, cores: number) => level * ram * cores;

  it("buys the cheapest affordable cache upgrade over ROI picks", () => {
    const { decision } = decideNodeInvestment(1e6, 0, 1, Infinity, true, nodes, gainRate, true);
    expect(decision).toEqual({ kind: "upgrade", index: 1, upgrade: "cache" });
  });

  it("falls back to the normal pick when no cache upgrade is affordable", () => {
    const { decision } = decideNodeInvestment(200, 0, 1, Infinity, true, nodes, gainRate, true);
    expect(decision.kind).toBe("upgrade");
    expect(decision).not.toMatchObject({ upgrade: "cache" });
  });

  it("ignores cache upgrades in ROI mode when capacity isn't needed", () => {
    const { decision } = decideNodeInvestment(1e6, 0, 1, Infinity, true, nodes, gainRate);
    expect(decision).not.toMatchObject({ upgrade: "cache" });
  });
});

describe("decideNodeInvestment maxPayback", () => {
  // level 10 -> 11 adds 1 unit/s per ram*cores = 1; cost 100 -> payback 100s at $1/unit.
  const node = { index: 0, level: 10, ram: 1, cores: 1, levelCost: 100, ramCost: Infinity, coreCost: Infinity };
  const gainRate = (level: number, ram: number, cores: number) => level * ram * cores;

  it("buys an upgrade that pays back within the limit", () => {
    const { decision } = decideNodeInvestment(1e6, 0, 1, Infinity, true, [node], gainRate, false, { seconds: 200, valuePerUnit: 1 });
    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "level" });
  });

  it("skips an upgrade that pays back too slowly", () => {
    const { decision } = decideNodeInvestment(1e6, 0, 1, Infinity, true, [node], gainRate, false, { seconds: 50, valuePerUnit: 1 });
    expect(decision).toEqual({ kind: "none" });
  });

  it("counts production value when judging payback", () => {
    const { decision } = decideNodeInvestment(1e6, 0, 1, Infinity, true, [node], gainRate, false, { seconds: 50, valuePerUnit: 2.5 });
    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "level" });
  });

  it("still buys cache for capacity regardless of payback", () => {
    const withCache = { ...node, cacheCost: 10 };
    const { decision } = decideNodeInvestment(1e6, 0, 1, Infinity, true, [withCache], gainRate, true, { seconds: 1, valuePerUnit: 1 });
    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "cache" });
  });
});

describe("prioritizeForActivity", () => {
  const priority = ["Improve Studying", "Improve Gym Training", "Company Favor"];

  it("puts Improve Gym Training first at the gym", () => {
    expect(prioritizeForActivity(priority, "gym")).toEqual(["Improve Gym Training", "Improve Studying", "Company Favor"]);
  });

  it("keeps Improve Studying first in class", () => {
    expect(prioritizeForActivity(priority, "class")).toEqual(priority);
  });

  it("leaves the order alone with no activity", () => {
    expect(prioritizeForActivity(priority, "none")).toEqual(priority);
    expect(prioritizeForActivity(priority, undefined)).toEqual(priority);
  });

  it("never adds an upgrade that isn't configured", () => {
    expect(prioritizeForActivity(["Improve Studying"], "gym")).toEqual(["Improve Studying"]);
  });
});
