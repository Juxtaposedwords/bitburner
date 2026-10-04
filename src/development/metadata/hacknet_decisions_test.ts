import { describe, expect, it } from "vitest";
import { chooseHashUpgrade, decideNodeInvestment, nodePolicy } from "development/metadata/hacknet_decisions";

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

describe("nodePolicy", () => {
  it("buys nothing during the install loop", () => {
    expect(nodePolicy(true, 1e12, 10)).toEqual({ kind: "none" });
  });

  it("caps each purchase at budgetMinutes of income, and the total at incomeShare of it", () => {
    expect(nodePolicy(false, 1.2e12, 10, 0.05, 5 / 60)).toEqual({ kind: "income", maxItemCost: 1.2e13, tickBudget: 5e9 });
  });

  it("spends a small share of cash without income data", () => {
    expect(nodePolicy(false, undefined, 10, 0.05, 5 / 60, 1e8)).toEqual({ kind: "income", maxItemCost: 2.5e7, tickBudget: 2e6 });
  });

  it("falls back to the payback test without income data or a budget", () => {
    expect(nodePolicy(false, undefined, 10)).toEqual({ kind: "payback" });
    expect(nodePolicy(false, 1e12, 0)).toEqual({ kind: "payback" });
  });
});

describe("decideNodeInvestment maxItemCost", () => {
  it("skips anything over the cap", () => {
    const nodes = [{ index: 0, level: 1, ram: 1, cores: 1, levelCost: 500, ramCost: 50, coreCost: 5000 }];
    const { decision } = decideNodeInvestment(1e6, 0, 1, 1e9, true, nodes, undefined, false, undefined, 100);
    expect(decision).toEqual({ kind: "upgrade", index: 0, upgrade: "ram" });
  });
});

describe("chooseHashUpgrade", () => {
  const costs = { "Improve Studying": 500, "Improve Gym Training": 500, "Company Favor": 200, "Reduce Minimum Security": 300, "Increase Maximum Money": 300, "Sell for Money": 4 };
  const base = { numHashes: 1000, capacity: 5000, costs, gymForGoal: false, classForGoal: false, sellAboveFraction: 0.9 };
  const earner = { host: "megacorp", chance: 1 };

  it("puts hashes into the top earner's max money when no goal needs training", () => {
    expect(chooseHashUpgrade({ ...base, topEarner: earner }).buy).toMatchObject({ upgrade: "Increase Maximum Money", target: "megacorp" });
  });

  it("trains first while a goal is blocked on a trained stat", () => {
    expect(chooseHashUpgrade({ ...base, topEarner: earner, gymForGoal: true }).buy?.upgrade).toBe("Improve Gym Training");
  });

  it("lowers min security only while the top earner's hack chance is low", () => {
    expect(chooseHashUpgrade({ ...base, topEarner: { host: "ecorp", chance: 0.6 } }).buy).toMatchObject({ upgrade: "Reduce Minimum Security", target: "ecorp" });
  });

  it("saves for the wanted upgrade instead of spending lower down", () => {
    const r = chooseHashUpgrade({ ...base, numHashes: 400, topEarner: earner, gymForGoal: true });
    expect(r.buy).toBeUndefined();
    expect(r.wanted?.upgrade).toBe("Improve Gym Training");
  });

  it("sells near capacity while saving for something unaffordable", () => {
    const r = chooseHashUpgrade({ ...base, numHashes: 4600, costs: { ...costs, "Increase Maximum Money": 9000 }, topEarner: earner });
    expect(r.buy?.upgrade).toBe("Sell for Money");
    expect(r.wanted?.upgrade).toBe("Increase Maximum Money");
  });
});
