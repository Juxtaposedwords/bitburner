import { it } from "vitest";
import { chooseMoveMinimax, DEFAULT_WEIGHTS, EvalWeights } from "go/go_decisions";
import { playAgainstAI } from "./harness";

// GO_GRID=1 npx vitest run --config gosim/vitest.config.ts gosim/grid_bench.ts
const GAMES = Number(process.env.GO_GAMES ?? 30);
const opponents = (process.env.GO_OPPONENTS ?? "Illuminati,Daedalus").split(",");

it.skipIf(!process.env.GO_GRID)("weight grid against the real AI", async () => {
  const grid: EvalWeights[] = [];
  for (const aggression of [0.5, 1, 2]) for (const chain of [1.5, 3, 5]) for (const alive of [1, 3]) grid.push({ ...DEFAULT_WEIGHTS, aggression, chain, alive });
  for (const opponent of opponents) {
    for (const depth of [2, 3]) {
      const rows = [];
      for (const w of grid) {
        let wins = 0, value = 0, wiped = 0;
        for (let seed = 1; seed <= GAMES; seed++) {
          const g = await playAgainstAI((b, m, h) => chooseMoveMinimax(b, m, h, depth, w), opponent, seed);
          wins += +g.won; value += g.value; wiped += +(g.score === 0);
        }
        rows.push({ w, wins, value: value / GAMES, wiped });
      }
      rows.sort((a, b) => b.value - a.value);
      for (const r of rows.slice(0, 3)) {
        process.stderr.write(`${opponent} d${depth} aggr ${r.w.aggression} chain ${r.w.chain} alive ${r.w.alive}: ${r.wins}/${GAMES}, wiped ${r.wiped}, value ${r.value.toFixed(1)}\n`);
      }
    }
  }
});
