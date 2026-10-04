import { DEFAULT_WEIGHTS, EvalWeights } from "go/go_decisions";
import { Board } from "go/go_engine";

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
// "search": plain alpha-beta (chooseMoveMinimax); "model": answer each
// candidate with the opponent's predicted replies (go_opponent_model.ts's
// chooseMoveModeled), with our best follow-up when `followUp`.
// `rolloutPlies`: with "model", moves each side plays on (us one-ply, them by the model) before scoring.
export type Strategy = { name: string; kind: "search" | "model"; depth: number; weights: EvalWeights; followUp?: boolean; rolloutPlies?: number };

const BALANCED: Strategy = { name: "balanced", kind: "search", depth: 3, weights: DEFAULT_WEIGHTS };
// Hunt weak groups: their chains short of liberties count double.
const HUNT: Strategy = { name: "hunt", kind: "search", depth: 3, weights: { ...DEFAULT_WEIGHTS, aggression: 2 } };
// Play safe and connected: one solid group, ours counted over theirs.
const SOLID: Strategy = { name: "solid", kind: "search", depth: 3, weights: { ...DEFAULT_WEIGHTS, chain: 4, aggression: 0.5 } };
// Make eyes first: a living group is worth much more than area.
const LIVE: Strategy = { name: "live", kind: "search", depth: 3, weights: { ...DEFAULT_WEIGHTS, alive: 3, chain: 4 } };

// Answer the opponent's predicted replies; with our follow-up, the
// position two moves on - best against Illuminati, worse elsewhere.
const MODEL: Strategy = { name: "model", kind: "model", depth: 1, weights: DEFAULT_WEIGHTS };
const MODEL_FOLLOW: Strategy = { name: "model+follow", kind: "model", depth: 1, weights: DEFAULT_WEIGHTS, followUp: true };
// Four more moves each, played out with the model: ~130 ms a move.
const MODEL_ROLLOUT: Strategy = { name: "rollout4", kind: "model", depth: 1, weights: DEFAULT_WEIGHTS, rolloutPlies: 4 };

/**
 * Candidates per opponent, the expected best first - from 60 games each
 * against the game's real AI (gosim/, node power per game): the opponent
 * model beat every search strategy against Illuminati (125.8 vs 69.7, with
 * follow-up), Tetrads (31.3 vs 21.7), Daedalus (34.2 vs 28.3) and The
 * Black Hand (23.8 vs 22.0), and tied against Slum Snakes and Netburners.
 * The best search strategy stays as the live comparison. Against
 * Illuminati, rollouts four moves deep did better still: ~121 node power
 * a game over 100 fresh games vs ~96 for model+follow (which stays as its
 * comparison); they didn't help against Daedalus or Tetrads.
 */
export const STRATEGIES: Record<string, Strategy[]> = {
  Netburners: [MODEL, BALANCED],
  "Slum Snakes": [MODEL, HUNT],
  "The Black Hand": [MODEL, BALANCED],
  Tetrads: [MODEL, SOLID],
  Daedalus: [MODEL, BALANCED],
  Illuminati: [MODEL_ROLLOUT, MODEL_FOLLOW],
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

// Redeals of one opponent's board in a row, at most.
export const MAX_REDEALS = 5;

/**
 * Whether a freshly dealt board is worth redealing before our first move
 * (free then: the game only charges a reset once moves are made). Against
 * Illuminati with its handicap stone on the center point we averaged ~81
 * node power a game vs ~112 otherwise (200 games against the real AI in
 * gosim/), so redealing those is worth ~+9%.
 */
export function shouldRedeal(opponent: string, board: Board): boolean {
  const n = board.length;
  const c = (n - 1) / 2;
  return opponent === "Illuminati" && n % 2 === 1 && board[c][c] === "O";
}
