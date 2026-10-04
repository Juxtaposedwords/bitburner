import { it } from "vitest";
import { playAgainstAI, Player_ } from "./harness";
import { modelPlayer } from "./model";

// GO_MODEL=1 npx vitest run --config gosim/vitest.config.ts gosim/model_bench.ts
const GAMES = Number(process.env.GO_GAMES ?? 30);
const opponents = (process.env.GO_OPPONENTS ?? "Illuminati,Daedalus").split(",");

it.skipIf(!process.env.GO_MODEL)("opponent modeling against the real AI", async () => {
  for (const opponent of opponents) {
    const players: [string, Player_][] = [
      ["model-6", modelPlayer(opponent, 6)],
      ["model-6+follow", modelPlayer(opponent, 6, undefined, true)],
    ];
    for (const [name, player] of players) {
      let wins = 0, value = 0, wiped = 0, score = 0;
      const t0 = Date.now();
      for (let seed = 1; seed <= GAMES; seed++) {
        const g = await playAgainstAI(player, opponent, seed);
        wins += +g.won; value += g.value; wiped += +(g.score === 0); score += g.score;
      }
      process.stderr.write(`${opponent.padEnd(11)} ${name.padEnd(15)} ${wins}/${GAMES} won, score ${(score / GAMES).toFixed(1)}, wiped ${wiped}, value ${(value / GAMES).toFixed(1)}, ${((Date.now() - t0) / GAMES).toFixed(0)} ms/game\n`);
    }
  }
});
