import { describe, it } from "vitest";
import { chooseMove, chooseMoveMinimax, difficultyMultiplier, MoveChoice, OPPONENTS } from "go/go_decisions";
import { area, Board, opponentOf, play, Point, Stone, territory } from "go/go_engine";
import { chooseMoveModeled, predictMove, Rng, seededRng } from "go/go_opponent_model";
import { strategiesFor } from "go/go_strategy";

// Offline strategy benchmark against our own model of the game's AI
// (go_opponent_model.ts) - no game code involved. The model predicts the
// real AI's move 53-81% of the time (measured 2026-10-04), so results are
// a guide; the daemon's live UCB1 makes the final call. Skipped unless
// asked for:
//   GO_BENCH=1 npx vitest run src/go/go_bench   (GO_GAMES, GO_OPPONENTS to narrow)
// src/ has no Node types; the environment is read through globalThis.
const node = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write: (s: string) => void } } }).process;
const env = node?.env ?? {};
// The test runner hides console.log; results go to stderr.
const report = (line: string): void => node?.stderr.write(line + "\n");
const GAMES = Number(env.GO_GAMES ?? 30);
const opponents = (env.GO_OPPONENTS ?? Object.keys(OPPONENTS).join(",")).split(",");

/** A fresh 5x5 deal like the game's: 1-3 dead nodes, and Illuminati's one handicap stone. */
function dealBoard(opponent: string, rng: Rng): Board {
  const b = Array.from({ length: 5 }, () => ".....".split(""));
  const dead = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < dead; i++) b[Math.floor(rng() * 5)][Math.floor(rng() * 5)] = "#";
  if (opponent === "Illuminati") {
    const spots: Point[] = [[1, 1], [1, 3], [3, 1], [3, 3], [2, 2]];
    const free = spots.filter(([x, y]) => b[x][y] === ".");
    const [hx, hy] = free[Math.floor(rng() * free.length)] ?? [2, 2];
    b[hx][hy] = "O";
  }
  return b.map((c) => c.join(""));
}

type Player = (board: Board, me: Stone, history: Board[]) => MoveChoice | Promise<MoveChoice>;

async function game(us: Player, opponent: string, seed: number): Promise<{ won: boolean; value: number; ms: number; moves: number }> {
  const rng = seededRng(seed);
  let board = dealBoard(opponent, rng);
  const history: Board[] = [];
  let passes = 0;
  let turn: Stone = "X";
  let ms = 0;
  let moves = 0;
  for (let n = 0; passes < 2 && n < 150; n++) {
    let choice: MoveChoice;
    if (turn === "X") {
      const t = performance.now();
      choice = await us(board, turn, history);
      ms += performance.now() - t;
      moves++;
    } else {
      choice = predictMove(opponent, board, turn, history, rng, passes > 0);
    }
    if (choice.kind === "pass") passes++;
    else {
      passes = 0;
      history.push(board);
      board = play(board, choice.x, choice.y, turn, history) ?? board;
    }
    turn = opponentOf(turn);
  }
  const owners = territory(board);
  const { komi } = OPPONENTS[opponent];
  const score = area(board, "X", owners);
  const won = score > area(board, "O", owners) + komi;
  return { won, value: score * difficultyMultiplier(komi, 5) * (won ? 1.25 : 0.5), ms, moves };
}

describe.skipIf(!env.GO_BENCH)("strategies against the model of the game's AI", () => {
  it("compares every opponent's strategies", async () => {
    for (const opponent of opponents) {
      const players: [string, Player][] = [
        ["one-ply", chooseMove],
        ...strategiesFor(opponent).map((s): [string, Player] => [
          s.name,
          s.kind === "model"
            ? (b, m, h) => chooseMoveModeled(opponent, b, m, h, { weights: s.weights, followUp: s.followUp ?? false, rolloutPlies: s.rolloutPlies })
            : (b, m, h) => chooseMoveMinimax(b, m, h, s.depth, s.weights),
        ]),
      ];
      for (const [name, player] of players) {
        let wins = 0, value = 0, ms = 0, moves = 0;
        for (let seed = 1; seed <= GAMES; seed++) {
          const g = await game(player, opponent, seed * 7919);
          wins += +g.won; value += g.value; ms += g.ms; moves += g.moves;
        }
        report(`${opponent.padEnd(15)} ${name.padEnd(13)} ${wins}/${GAMES} won, value/game ${(value / GAMES).toFixed(1)}, ${(ms / moves).toFixed(1)} ms/move`);
      }
    }
  }, 3_600_000);
});
