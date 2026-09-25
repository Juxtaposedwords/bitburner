import { describe, expect, it } from "vitest";
import { BuyCandidate, decideStocksToSell, decideStockToBuy, StockPosition } from "development/metadata/stock_decisions";

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
  it("picks the highest-forecast candidate among several", () => {
    const candidates = [candidate({ sym: "Cheap", forecast: 0.61 }), candidate({ sym: "Best", forecast: 0.9 })];
    const affordableShares = () => 10;

    const { decision } = decideStockToBuy(candidates, 100_000, 0, 1, 1, affordableShares);

    expect(decision).toEqual({ sym: "Best", shares: 10 });
  });

  it("computes budget as the tighter of reserveMoney and maxSpendFraction, same pairing as decideNodeInvestment", () => {
    // money=1000, reserve=800 -> only 200 spendable, vs fraction 0.5 -> 500. Reserve wins.
    const { budget } = decideStockToBuy([], 1000, 800, 0.5, 1, () => 0);

    expect(budget).toBe(200);
  });

  it("passes each candidate's own position-capped budget to affordableShares", () => {
    const seenBudgets: number[] = [];
    const affordableShares = (_sym: string, budgetForSymbol: number) => {
      seenBudgets.push(budgetForSymbol);
      return budgetForSymbol > 0 ? 1 : 0;
    };

    // money=1000, maxPositionFraction=0.25 -> position cap is 250 - tighter
    // than the general budget (maxSpendFraction=1 -> 1000).
    decideStockToBuy([candidate({ existingCostBasis: 0 })], 1000, 0, 1, 0.25, affordableShares);

    expect(seenBudgets).toEqual([250]);
  });

  it("a candidate already at its position cap gets zero symbol budget, even with general budget remaining", () => {
    const seenBudgets: number[] = [];
    const affordableShares = (_sym: string, budgetForSymbol: number) => {
      seenBudgets.push(budgetForSymbol);
      return 0;
    };

    // Position cap = 0.25*1000 - existingCostBasis(300) = -50 -> clamped to 0.
    decideStockToBuy([candidate({ existingCostBasis: 300 })], 1000, 0, 1, 0.25, affordableShares);

    expect(seenBudgets).toEqual([0]);
  });

  it("does not get stuck on a capped-out best candidate - picks the next-best affordable one instead", () => {
    const maxed = candidate({ sym: "Maxed", forecast: 0.95, existingCostBasis: 1_000_000 });
    const runnerUp = candidate({ sym: "RunnerUp", forecast: 0.8, existingCostBasis: 0 });
    const affordableShares = (sym: string, budgetForSymbol: number) => (sym === "Maxed" ? 0 : budgetForSymbol > 0 ? 5 : 0);

    const { decision, bestCandidate } = decideStockToBuy([maxed, runnerUp], 100_000, 0, 1, 0.25, affordableShares);

    // bestCandidate still reports the globally-highest forecast for
    // diagnosability, even though it wasn't the one actually bought.
    expect(bestCandidate).toEqual({ sym: "Maxed", forecast: 0.95 });
    expect(decision).toEqual({ sym: "RunnerUp", shares: 5 });
  });

  it("returns no decision when nothing is affordable", () => {
    const { decision } = decideStockToBuy([candidate()], 100_000, 0, 1, 1, () => 0);

    expect(decision).toBeUndefined();
  });

  it("returns undefined decision and candidateCount 0 for an empty candidate list", () => {
    const { decision, candidateCount, bestCandidate } = decideStockToBuy([], 100_000, 0, 1, 1, () => 10);

    expect(decision).toBeUndefined();
    expect(candidateCount).toBe(0);
    expect(bestCandidate).toBeUndefined();
  });

  it("reports diagnostic fields even when nothing is affordable", () => {
    const { budget, candidateCount, bestCandidate } = decideStockToBuy(
      [candidate({ sym: "ECP", forecast: 0.72 })],
      100_000,
      0,
      1,
      1,
      () => 0
    );

    expect(budget).toBe(100_000);
    expect(candidateCount).toBe(1);
    expect(bestCandidate).toEqual({ sym: "ECP", forecast: 0.72 });
  });
});
