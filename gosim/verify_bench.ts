import { it } from "vitest";
import { chooseMove, chooseMoveMinimax, DEFAULT_WEIGHTS, EvalWeights } from "go/go_decisions";
import { playAgainstAI, Player_ } from "./harness";
import { modelPlayer } from "./model";

// Fresh seeds (101+) for settings the grid picked on seeds 1-30.
const GAMES = Number(process.env.GO_GAMES ?? 60);
const mm = (depth: number, w: EvalWeights): Player_ => (b, m, h) => chooseMoveMinimax(b, m, h, depth, w);

it.skipIf(!process.env.GO_VERIFY)("verify on fresh seeds", async () => {
  const runs: [string, string, Player_][] = process.env.GO_VERIFY === "model" ? [["Illuminati", "model-6+follow", modelPlayer("Illuminati", 6, undefined, true)], ["Daedalus", "model-6", modelPlayer("Daedalus", 6)]] : [
    ["Illuminati", "balanced d3 (live now)", mm(3, DEFAULT_WEIGHTS)],
    ["Illuminati", "d2 chain 1.5 alive 3", mm(2, { ...DEFAULT_WEIGHTS, chain: 1.5, alive: 3 })],
    ["Illuminati", "d2 chain 5 alive 3", mm(2, { ...DEFAULT_WEIGHTS, chain: 5, alive: 3 })],
    ["Daedalus", "one-ply", chooseMove],
    ["Daedalus", "d2 aggr 2 chain 5 alive 3", mm(2, { ...DEFAULT_WEIGHTS, aggression: 2, chain: 5, alive: 3 })],
    ["Daedalus", "d3 chain 5", mm(3, { ...DEFAULT_WEIGHTS, chain: 5 })],
  ];
  for (const [opponent, name, player] of runs) {
    let wins = 0, value = 0, wiped = 0;
    for (let seed = 101; seed < 101 + GAMES; seed++) {
      const g = await playAgainstAI(player, opponent, seed);
      wins += +g.won; value += g.value; wiped += +(g.score === 0);
    }
    process.stderr.write(`${opponent.padEnd(11)} ${name.padEnd(26)} ${wins}/${GAMES} won, wiped ${wiped}, value ${(value / GAMES).toFixed(1)}\n`);
  }
});
