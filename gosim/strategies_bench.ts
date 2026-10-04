import { it } from "vitest";
import { chooseMove, chooseMoveMinimax, OPPONENTS } from "go/go_decisions";
import { strategiesFor } from "go/go_strategy";
import { playAgainstAI, Player_ } from "./harness";

// npx vitest run --config gosim/vitest.config.ts  (GO_GAMES, GO_OPPONENTS to narrow)
const GAMES = Number(process.env.GO_GAMES ?? 40);
const only = process.env.GO_OPPONENTS?.split(",");

it("strategies against the real AI", async () => {
  for (const opponent of Object.keys(OPPONENTS).filter((o) => !only || only.includes(o))) {
    const players: [string, Player_][] = [
      ["one-ply", chooseMove],
      ...strategiesFor(opponent).map((s): [string, Player_] => [s.name, (b, m, h) => chooseMoveMinimax(b, m, h, s.depth, s.weights)]),
    ];
    for (const [name, player] of players) {
      let wins = 0, score = 0, value = 0, wiped = 0;
      const t0 = Date.now();
      for (let seed = 1; seed <= GAMES; seed++) {
        const g = await playAgainstAI(player, opponent, seed);
        wins += +g.won; score += g.score; value += g.value; wiped += +(g.score === 0);
      }
      process.stderr.write(
        `${opponent.padEnd(15)} ${name.padEnd(9)} ${String(wins).padStart(2)}/${GAMES} won, score ${(score / GAMES).toFixed(1)}, ` +
          `wiped ${wiped}, value/game ${(value / GAMES).toFixed(1)}, ${((Date.now() - t0) / GAMES).toFixed(0)} ms/game\n`
      );
    }
  }
});
