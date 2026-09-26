import { describe, expect, it } from "vitest";
import { BuyCandidate, BuyLimits, decideStocksToSell, decideStockToBuy, StockPosition } from "development/metadata/stock_decisions";

const position = (overrides: Partial<StockPosition> = {}): StockPosition => ({
  sym: "ECP",
  shares: 100,
  costBasis: 10_000,
  position: "L",
  ...overrides,
});

const candidate = (overrides: Partial<BuyCandidate> = {}): BuyCandidate => ({
  sym: "ECP",
  forecast: 0.7,
  existingCostBasis: 0,
  ...overrides,
});

// No throttles unless a test sets one - isolates whichever cap it's testing.
const limits = (overrides: Partial<BuyLimits> = {}): BuyLimits => ({
  reserveMoney: 0,
  maxSpendFraction: 1,
  maxPositionFraction: 1,
  maxInvestedFraction: 1,
  ...overrides,
});

// Linear stand-in for the daemon's binary search: $1 per share.
const linear = (_sym: string, budget: number) => ({ shares: Math.floor(budget), cost: Math.floor(budget) });

describe("decideStocksToSell", () => {
  it("sells a position whose forecast has dropped to sellThreshold", () => {
    const positions = [position({ sym: "ECP" })];
    const forecasts = new Map([["ECP", 0.5]]);

    expect(decideStocksToSell(positions, forecasts, 0.5)).toEqual([{ sym: "ECP", shares: 100 }]);
  });

  it("sells a position whose forecast has dropped below sellThreshold", () => {
    const positions = [position({ sym: "ECP" })];
    const forecasts = new Map([["ECP", 0.3]]);

    expect(decideStocksToSell(positions, forecasts, 0.5)).toEqual([{ sym: "ECP", shares: 100 }]);
  });

  it("holds a position whose forecast is still strictly above sellThreshold", () => {
    const positions = [position({ sym: "ECP" })];
    const forecasts = new Map([["ECP", 0.51]]);

    expect(decideStocksToSell(positions, forecasts, 0.5)).toEqual([]);
  });

  it("holds (does not sell) a position missing from forecasts - defaults to neutral 0.5, not 0", () => {
    const positions = [position({ sym: "ECP" })];
    const forecasts = new Map<string, number>();

    expect(decideStocksToSell(positions, forecasts, 0.5)).toEqual([]);
  });

  it("returns every qualifying exit in one call, not capped to one per tick", () => {
    const positions = [position({ sym: "A" }), position({ sym: "B" }), position({ sym: "C" })];
    const forecasts = new Map([
      ["A", 0.4],
      ["B", 0.5],
      ["C", 0.9],
    ]);

    expect(decideStocksToSell(positions, forecasts, 0.5)).toEqual([
      { sym: "A", shares: 100 },
      { sym: "B", shares: 100 },
    ]);
  });

  it("returns an empty array when nothing is held", () => {
    expect(decideStocksToSell([], new Map(), 0.5)).toEqual([]);
  });
});

describe("decideStockToBuy", () => {
  it("fills the highest-forecast candidate first", () => {
    const candidates = [candidate({ sym: "Low", forecast: 0.61 }), candidate({ sym: "High", forecast: 0.9 })];

    const { decisions } = decideStockToBuy(candidates, 1000, 0, limits({ maxPositionFraction: 0.25 }), linear);

    expect(decisions[0]).toEqual({ sym: "High", shares: 250 });
  });

  it("spreads the budget across several candidates once the top one hits its position cap - the live MGCP-only bug", () => {
    const candidates = [candidate({ sym: "A", forecast: 0.9 }), candidate({ sym: "B", forecast: 0.8 }), candidate({ sym: "C", forecast: 0.7 })];

    // Net worth 1000, 25% per symbol -> 250 each; budget 600 covers A, B, and part of C.
    const { decisions } = decideStockToBuy(candidates, 1000, 0, limits({ maxPositionFraction: 0.25, maxSpendFraction: 0.6 }), linear);

    expect(decisions).toEqual([
      { sym: "A", shares: 250 },
      { sym: "B", shares: 250 },
      { sym: "C", shares: 100 },
    ]);
  });

  it("measures the position cap against net worth (cash + invested), not cash alone", () => {
    // Cash 100, already invested 900 in other symbols -> net worth 1000, cap 250.
    // A cash-only cap would allow just 25.
    const { decisions } = decideStockToBuy([candidate({ sym: "New" })], 100, 900, limits({ maxPositionFraction: 0.25 }), linear);

    expect(decisions).toEqual([{ sym: "New", shares: 100 }]); // bounded by cash (100), not the cap
  });

  it("skips a candidate already at its position cap and moves on to the next", () => {
    const capped = candidate({ sym: "Capped", forecast: 0.95, existingCostBasis: 250 });
    const next = candidate({ sym: "Next", forecast: 0.8 });

    // Net worth = 750 cash + 250 invested = 1000; Capped already holds its 250.
    const { decisions, bestCandidate } = decideStockToBuy([capped, next], 750, 250, limits({ maxPositionFraction: 0.25 }), linear);

    expect(bestCandidate).toEqual({ sym: "Capped", forecast: 0.95 }); // still reported for diagnosability
    expect(decisions).toEqual([{ sym: "Next", shares: 250 }]);
  });

  it("maxInvestedFraction caps total stock exposure, keeping the rest in cash", () => {
    // Net worth 1000, 50% max invested, 400 already in -> only 100 more allowed.
    const { budget, decisions } = decideStockToBuy([candidate()], 600, 400, limits({ maxInvestedFraction: 0.5 }), linear);

    expect(budget).toBe(100);
    expect(decisions).toEqual([{ sym: "ECP", shares: 100 }]);
  });

  it("computes the spend budget as the tighter of reserveMoney and maxSpendFraction, same pairing as decideNodeInvestment", () => {
    // money=1000, reserve=800 -> only 200 spendable, vs fraction 0.5 -> 500. Reserve wins.
    const { budget } = decideStockToBuy([], 1000, 0, limits({ reserveMoney: 800, maxSpendFraction: 0.5 }), linear);

    expect(budget).toBe(200);
  });

  it("deducts each purchase's real cost from the remaining budget", () => {
    // Non-linear stand-in: every buy costs exactly 150 regardless of budget.
    const flat = (_sym: string, budget: number) => (budget >= 150 ? { shares: 1, cost: 150 } : { shares: 0, cost: 0 });
    const candidates = [candidate({ sym: "A", forecast: 0.9 }), candidate({ sym: "B", forecast: 0.8 }), candidate({ sym: "C", forecast: 0.7 })];

    const { decisions } = decideStockToBuy(candidates, 300, 0, limits(), flat);

    expect(decisions.map((d) => d.sym)).toEqual(["A", "B"]);
  });

  it("returns no decisions when nothing is affordable", () => {
    const { decisions } = decideStockToBuy([candidate()], 100_000, 0, limits(), () => ({ shares: 0, cost: 0 }));

    expect(decisions).toEqual([]);
  });

  it("returns no decisions, candidateCount 0, and no bestCandidate for an empty candidate list", () => {
    const { decisions, candidateCount, bestCandidate } = decideStockToBuy([], 100_000, 0, limits(), linear);

    expect(decisions).toEqual([]);
    expect(candidateCount).toBe(0);
    expect(bestCandidate).toBeUndefined();
  });

  it("reports diagnostic fields even when nothing is affordable", () => {
    const { budget, candidateCount, bestCandidate } = decideStockToBuy(
      [candidate({ sym: "ECP", forecast: 0.72 })],
      100_000,
      0,
      limits(),
      () => ({ shares: 0, cost: 0 })
    );

    expect(budget).toBe(100_000);
    expect(candidateCount).toBe(1);
    expect(bestCandidate).toEqual({ sym: "ECP", forecast: 0.72 });
  });
});
