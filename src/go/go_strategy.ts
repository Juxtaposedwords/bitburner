import { DEFAULT_WEIGHTS, EvalWeights } from "go/go_decisions";

/**
 * Strategies per opponent style, chosen live. The game's AIs differ a lot
 * (Go/boardAnalysis/goAI.ts): Netburners mostly play at random and never
 * avoid self-atari; Slum Snakes grow long chains and rarely make eyes; The
 * Black Hand surrounds anything short of liberties; Tetrads fight at close
 * range; Illuminati (and Daedalus, which copies it 90% of the time) makes
 * eyes, blocks ours and takes corners.
 *
 * Each opponent gets a few candidate strategies - evaluation weights and
 * search depth - screened offline against simulated opponents
 * (go_sim.ts, go_tune_test.ts). The simulations can't match the real AIs'
 * strength, so the choice between candidates is made on real games: UCB1
 * on node power per game (pickStrategy).
 */
export type Strategy = { name: string; depth: number; weights: EvalWeights };

const BALANCED: Strategy = { name: "balanced", depth: 3, weights: DEFAULT_WEIGHTS };
// Hunt weak groups: their chains short of liberties count double.
const HUNT: Strategy = { name: "hunt", depth: 3, weights: { ...DEFAULT_WEIGHTS, aggression: 2 } };
// Play safe and connected: one solid group, ours counted over theirs.
const SOLID: Strategy = { name: "solid", depth: 3, weights: { ...DEFAULT_WEIGHTS, chain: 4, aggression: 0.5 } };
// Make eyes first: a living group is worth much more than area.
const LIVE: Strategy = { name: "live", depth: 3, weights: { ...DEFAULT_WEIGHTS, alive: 3, chain: 4 } };

/** Candidates per opponent, the expected best first. */
export const STRATEGIES: Record<string, Strategy[]> = {
  // Never filters self-atari: punish loose stones.
  Netburners: [HUNT, BALANCED],
  // Long chains without eyes: squeeze them.
  "Slum Snakes": [HUNT, BALANCED, SOLID],
  // Surrounds anything weak: stay connected, counter-capture.
  "The Black Hand": [SOLID, BALANCED, HUNT],
  // Close fighting: solid shape.
  Tetrads: [SOLID, BALANCED, LIVE],
  // Eyes, eye blocks and corners (one handicap stone for Illuminati): live first.
  Daedalus: [LIVE, BALANCED, SOLID],
  Illuminati: [LIVE, BALANCED, SOLID],
};

export function strategiesFor(opponent: string): Strategy[] {
  return STRATEGIES[opponent] ?? [BALANCED];
}

// [games, total value]
export type StrategyStats = [number, number];

const EXPLORATION = 0.5;

/**
 * UCB1 over the candidates: each is tried once, in order, then the best
 * average value plus an exploration bonus that shrinks with games played.
 * Averages are normalized by the best one, so the bonus means the same at
 * any scale of node power.
 */
export function pickStrategy(candidates: Strategy[], stats: Record<string, StrategyStats> | undefined): Strategy {
  const seen = candidates.map((c) => stats?.[c.name] ?? ([0, 0] as StrategyStats));
  const untried = seen.findIndex(([games]) => games === 0);
  if (untried !== -1) return candidates[untried];
  const total = seen.reduce((sum, [games]) => sum + games, 0);
  const means = seen.map(([games, value]) => value / games);
  const scale = Math.max(1e-9, ...means.map(Math.abs));
  let best = 0;
  let bestBound = -Infinity;
  seen.forEach(([games], i) => {
    const bound = means[i] / scale + EXPLORATION * Math.sqrt(Math.log(total) / games);
    if (bound > bestBound) {
      bestBound = bound;
      best = i;
    }
  });
  return candidates[best];
}

export function recordStrategy(
  stats: Record<string, Record<string, StrategyStats>>,
  opponent: string,
  strategy: string,
  value: number
): Record<string, Record<string, StrategyStats>> {
  const mine = { ...(stats[opponent] ?? {}) };
  const [games, total] = mine[strategy] ?? [0, 0];
  mine[strategy] = [games + 1, total + value];
  return { ...stats, [opponent]: mine };
}

/**
 * A game's value for comparing strategies: node power with the streak
 * multiplier fixed (a win at 1.25, a loss at 0.5) - the streak comes from
 * earlier games, not the strategy played in this one.
 */
export function strategyValue(blackScore: number, difficulty: number, won: boolean): number {
  return blackScore * difficulty * (won ? 1.25 : 0.5);
}
