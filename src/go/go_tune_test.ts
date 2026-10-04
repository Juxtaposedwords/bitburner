import { describe, it } from "vitest";
import { chooseMoveMinimax, DEFAULT_WEIGHTS, difficultyMultiplier, EvalWeights, OPPONENTS } from "go/go_decisions";
import { simGame } from "go/go_sim";

// Offline tuning, not a regular test: GO_TUNE=1 npx vitest run src/go/go_tune
const GAMES = Number(process.env.GO_GAMES ?? 40);

function measure(opponent: string, w: EvalWeights, depth: number): { wins: number; score: number; power: number } {
  let wins = 0;
  let score = 0;
  let power = 0;
  const { komi } = OPPONENTS[opponent];
  for (let seed = 1; seed <= GAMES; seed++) {
    const r = simGame((b, m, h) => chooseMoveMinimax(b, m, h, depth, w), opponent, komi, seed * 7919);
    wins += +r.won;
    score += r.score;
    power += r.score * difficultyMultiplier(komi, 5) * (r.won ? 1.25 : 0.5);
  }
  return { wins, score: score / GAMES, power: power / GAMES };
}

describe.skipIf(!process.env.GO_TUNE)("tune strategies against simulated opponents", () => {
  it.skipIf(!!process.env.GO_GRID)("baseline", () => {
    for (const opponent of Object.keys(OPPONENTS)) {
      const r = measure(opponent, DEFAULT_WEIGHTS, 3);
      process.stderr.write(`${opponent.padEnd(15)} default d3: ${r.wins}/${GAMES} wins, score ${r.score.toFixed(1)}, power/game ${r.power.toFixed(1)}\n`);
    }
  }, 1_800_000);

  it("grid", () => {
    const grid: EvalWeights[] = [];
    for (const aggression of [0.5, 1, 2]) for (const chain of [1.5, 4]) for (const alive of [1, 3]) grid.push({ ...DEFAULT_WEIGHTS, aggression, chain, alive });
    for (const opponent of Object.keys(OPPONENTS)) {
      const rows = grid.map((w) => ({ w, ...measure(opponent, w, 3) })).sort((a, b) => b.power - a.power);
      for (const r of rows.slice(0, 4)) {
        process.stderr.write(`${opponent.padEnd(15)} aggr ${r.w.aggression} chain ${r.w.chain} alive ${r.w.alive}: ${r.wins}/${GAMES}, score ${r.score.toFixed(1)}, power ${r.power.toFixed(1)}\n`);
      }
    }
  }, 3_600_000);
});
