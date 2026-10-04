import { it } from "vitest";
import fs from "node:fs";
import { eyesOf, sensibleMoves } from "go/go_decisions";
import { Board, chainsOf, play, territory } from "go/go_engine";

// Replays recorded wiped games (record_bench.ts) to the position of our first pass.
// GO_REPLAY=1 npx vitest run --config gosim/vitest.config.ts gosim/replay_bench.ts
const show = (b: Board) => [4, 3, 2, 1, 0].map((y) => b.map((c) => c[y]).join(" ")).join("\n");
it.skipIf(!process.env.GO_REPLAY)("replay wiped games", () => {
  const games = fs.readFileSync("gosim/Illuminati_games_results.txt", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const stats = { wiped: 0, passedFirst: 0, passWithSensible0: 0, passOwnAreaOnly: 0 };
  let shown = 0;
  for (const g of games.filter((g) => g.score === 0)) {
    stats.wiped++;
    let board: Board = g.start;
    const history: Board[] = [];
    for (const mv of g.line as string[]) {
      if (mv === "Xpass") {
        stats.passedFirst++;
        const sensible = sensibleMoves(board, "X", history).length;
        const ownOnly = sensibleMoves(board, "X", history, true).length;
        if (sensible === 0) stats.passWithSensible0++;
        if (sensible === 0 && ownOnly > 0) stats.passOwnAreaOnly++;
        if (shown++ < 4) {
          const chains = chainsOf(board, "X").map((ch) => `${ch.stones.length}st/${ch.liberties.size}lib/${eyesOf(board, ch)}eyes`);
          const own = [...territory(board).entries()].filter(([, w]) => w === "X").length;
          process.stderr.write(`seed ${g.seed} first pass, sensible=${sensible} (own-area rule: ${ownOnly}), our area points=${own}, chains ${chains.join(", ")}\n${show(board)}\nthen: ${g.line.slice(g.line.indexOf(mv)).join(" ")}\n\n`);
        }
        break;
      }
      const color = mv[0] as "X" | "O";
      if (mv.endsWith("pass")) continue;
      const next = play(board, Number(mv[1]), Number(mv[2]), color, history);
      history.push(board);
      board = next ?? board;
    }
  }
  process.stderr.write(JSON.stringify(stats) + "\n");
});
