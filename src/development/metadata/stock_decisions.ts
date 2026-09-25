/**
 * Pure decision logic for stock_daemon.ts - no `ns` dependency, mirrors
 * hacknet_decisions.ts's shape. Long-only v1 (see StockPosition's
 * position: "L" tag) - the daemon buys when a stock's forecast clears
 * buyThreshold and sells to exit once it drops back to sellThreshold,
 * re-deriving everything fresh every tick rather than tracking a plan
 * across calls, the same "no lookahead" house style used everywhere else
 * in this codebase.
 */
export type StockPosition = { sym: string; shares: number; costBasis: number; position: "L" };

/**
 * Evaluates EVERY held position each tick and returns every one whose
 * forecast has dropped to sellThreshold or below - unbounded, not capped
 * to one per tick. Mirrors gang_daemon.ts's assignTasks/assignTraining
 * acting on the whole member roster every tick, not one member at a
 * time: exiting a no-longer-favorable position is risk reduction, not a
 * new commitment, so there's no reason to throttle it the way new spend
 * is throttled below.
 *
 * A symbol missing from `forecasts` (e.g. a transient gap) is always
 * held, never sold - "no information" must never be treated as a reason
 * to exit. This can't be done by just defaulting the missing value to
 * 0.5 (neutral) and running it through the same `<= sellThreshold`
 * comparison: 0.5 IS this daemon's own default sellThreshold, so that
 * fallback would still trigger a sell right at the boundary - caught by
 * this file's own test suite. Missing data is therefore its own
 * explicit branch, not a defaulted value fed into the normal check.
 */
export function decideStocksToSell(
  positions: StockPosition[],
  forecasts: Map<string, number>,
  sellThreshold: number
): { sym: string; shares: number }[] {
  return positions
    .filter((p) => forecasts.has(p.sym) && (forecasts.get(p.sym) as number) <= sellThreshold)
    .map((p) => ({ sym: p.sym, shares: p.shares }));
}

export type BuyCandidate = { sym: string; forecast: number; existingCostBasis: number };

/**
 * Full picture of one tick's buy evaluation, not just the winning
 * decision - same diagnosability contract as hacknet_decisions.ts's
 * InvestmentEvaluation. `bestCandidate` is the single highest-forecast
 * candidate found, whether or not it was actually affordable/under its
 * position cap - enough to diagnose a stuck tick without spamming the log.
 */
export type BuyEvaluation = {
  decision?: { sym: string; shares: number };
  budget: number;
  candidateCount: number;
  bestCandidate?: { sym: string; forecast: number };
};

/**
 * Picks at most one symbol to buy this tick - the highest-forecast
 * candidate among those that are both affordable and still under their
 * per-symbol position cap. Mirrors decideNodeInvestment's exact shape:
 * every candidate gets its own affordable-shares figure computed first
 * (respecting its OWN maxPositionFraction cap via `existingCostBasis`),
 * THEN the best-scoring one among those with a nonzero result wins - not
 * "pick globally-best-forecast first, then check if it's capped," which
 * would get stuck reporting the same maxed-out winner forever even while
 * budget remains for a second-best candidate that isn't capped.
 *
 * `budget` pairs an absolute floor (reserveMoney) with a relative
 * throttle (maxSpendFraction of current money) exactly like every other
 * spending daemon's decision function in this codebase.
 *
 * `affordableShares` is an injected closure (mirrors
 * purchased_server_decisions.ts's cost-closure pattern) rather than this
 * function calling ns.stock.getPurchaseCost itself, since price isn't
 * linear in share count and this module stays ns-free - a test can pass
 * a trivial linear stand-in; the real closure (stock_daemon.ts)
 * binary-searches getPurchaseCost/getMaxShares for the largest
 * affordable count.
 */
export function decideStockToBuy(
  candidates: BuyCandidate[],
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  maxPositionFraction: number,
  affordableShares: (sym: string, budgetForSymbol: number) => number
): BuyEvaluation {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));

  if (candidates.length === 0) return { budget, candidateCount: 0 };

  const bestCandidate = candidates.reduce((a, b) => (b.forecast > a.forecast ? b : a));

  const scored = candidates.map((candidate) => {
    const positionCap = Math.max(0, maxPositionFraction * money - candidate.existingCostBasis);
    const symbolBudget = Math.min(budget, positionCap);
    return { candidate, shares: affordableShares(candidate.sym, symbolBudget) };
  });

  const affordable = scored.filter((s) => s.shares > 0);
  const winner =
    affordable.length === 0 ? undefined : affordable.reduce((a, b) => (b.candidate.forecast > a.candidate.forecast ? b : a));

  return {
    decision: winner ? { sym: winner.candidate.sym, shares: winner.shares } : undefined,
    budget,
    candidateCount: candidates.length,
    bestCandidate: { sym: bestCandidate.sym, forecast: bestCandidate.forecast },
  };
}
