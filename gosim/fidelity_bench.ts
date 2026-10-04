import { it } from "vitest";
import { chooseMove, OPPONENTS } from "go/go_decisions";
import { predictMove, seededRng } from "go/go_opponent_model";
import { playAgainstAI } from "./harness";

// How well our opponent model predicts the real AI: at every AI move in
// real games, sample the model SAMPLES times; top-1 = its most frequent
// prediction is the AI's move, covered = any sample is.
// GO_FIDELITY=1 npx vitest run --config gosim/vitest.config.ts gosim/fidelity_bench.ts
const GAMES = Number(process.env.GO_GAMES ?? 20);
const SAMPLES = 16;
const opponents = (process.env.GO_OPPONENTS ?? Object.keys(OPPONENTS).join(",")).split(",");

it.skipIf(!process.env.GO_FIDELITY)("model fidelity", async () => {
  for (const opponent of opponents) {
    let positions = 0, top1 = 0, covered = 0;
    const rng = seededRng(99);
    for (let seed = 1; seed <= GAMES; seed++) {
      await playAgainstAI(chooseMove, opponent, seed, 5, (board, history, actual) => {
        const counts = new Map<string, number>();
        for (let i = 0; i < SAMPLES; i++) {
          const m = predictMove(opponent, board, "O", history, rng);
          const k = m.kind === "move" ? `${m.x},${m.y}` : "pass";
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        positions++;
        top1 += +(best === actual);
        covered += +counts.has(actual);
      });
    }
    process.stderr.write(`${opponent.padEnd(15)} ${positions} AI moves: top-1 ${((100 * top1) / positions).toFixed(0)}%, covered ${((100 * covered) / positions).toFixed(0)}%\n`);
  }
});
