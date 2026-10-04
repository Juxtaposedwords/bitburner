import { it } from "vitest";
import fs from "node:fs";
import { chooseMoveModeled } from "go/go_opponent_model";
import { strategiesFor } from "go/go_strategy";
import { playAgainstAI } from "./harness";

// Plays GO_GAMES games with an opponent's first strategy and writes every
// game (starting layout, final board, moves, value) to gosim/<opponent>_games_results.txt (JSON lines).
// GO_RECORD=1 npx vitest run --config gosim/vitest.config.ts gosim/record_bench.ts
const GAMES = Number(process.env.GO_GAMES ?? 200);
const opponent = process.env.GO_OPPONENTS ?? "Illuminati";
const SEED = Number(process.env.GO_SEED ?? 1001);

it.skipIf(!process.env.GO_RECORD)("record games", async () => {
  const s = strategiesFor(opponent)[0];
  const out = fs.createWriteStream(`gosim/${opponent.replace(/ /g, "_")}_games_results.txt`);
  for (let seed = SEED; seed < SEED + GAMES; seed++) {
    const g = await playAgainstAI(
      (b, m, h) => chooseMoveModeled(opponent, b, m, h, { weights: s.weights, followUp: s.followUp ?? false, rolloutPlies: s.rolloutPlies }),
      opponent,
      seed
    );
    out.write(JSON.stringify({ seed, ...g }) + "\n");
  }
  out.end();
});
