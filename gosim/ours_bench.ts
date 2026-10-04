import { it } from "vitest";
import { OPPONENTS } from "go/go_decisions";
import { chooseMoveModeled } from "go/go_opponent_model";
import { playAgainstAI } from "./harness";

// Our own opponent model (src/go/go_opponent_model.ts) against the real AI, fresh seeds.
// GO_OURS=1 npx vitest run --config gosim/vitest.config.ts gosim/ours_bench.ts
const GAMES = Number(process.env.GO_GAMES ?? 60);
const opponents = (process.env.GO_OPPONENTS ?? Object.keys(OPPONENTS).join(",")).split(",");

it.skipIf(!process.env.GO_OURS)("our opponent model against the real AI", async () => {
  for (const opponent of opponents) {
    for (const followUp of [true, false]) {
      let wins = 0, value = 0, wiped = 0, moves = 0, worst = 0, ms = 0;
      for (let seed = 101; seed < 101 + GAMES; seed++) {
        const g = await playAgainstAI(async (b, m, h) => {
          const t = Date.now();
          const c = await chooseMoveModeled(opponent, b, m, h, { followUp });
          const d = Date.now() - t; worst = Math.max(worst, d); ms += d; moves++;
          return c;
        }, opponent, seed);
        wins += +g.won; value += g.value; wiped += +(g.score === 0);
      }
      process.stderr.write(`${opponent.padEnd(15)} model${followUp ? "+follow" : "       "} ${wins}/${GAMES} won, wiped ${wiped}, value ${(value / GAMES).toFixed(1)}, ${(ms / moves).toFixed(0)} ms/move (worst ${worst})\n`);
    }
  }
});
