import { describe, expect, it } from "vitest";
import { chooseMove } from "go/go_decisions";
import { area, Board, emptyPoints, play, territory } from "go/go_engine";

// A seeded random opponent: plays any legal move that isn't filling its own territory.
function rng(seed: number): () => number {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function randomMove(board: Board, history: Board[], random: () => number): Board | undefined {
  const owners = territory(board);
  const options = emptyPoints(board)
    .filter(([x, y]) => owners.get(`${x},${y}`) !== "O")
    .map(([x, y]) => play(board, x, y, "O", history))
    .filter((b): b is Board => b !== undefined);
  return options.length === 0 ? undefined : options[Math.floor(random() * options.length)];
}

function game(size: number, seed: number): { won: boolean; moves: number } {
  const random = rng(seed);
  let board: Board = Array(size).fill(".".repeat(size));
  const history: Board[] = [];
  let passes = 0;
  let moves = 0;
  while (passes < 2 && moves < size * size * 4) {
    moves++;
    const choice = chooseMove(board, "X", history);
    if (choice.kind === "pass") passes++;
    else {
      passes = 0;
      history.push(board);
      board = play(board, choice.x, choice.y, "X", history) as Board;
    }
    const reply = randomMove(board, history, random);
    if (!reply) passes++;
    else {
      passes = 0;
      history.push(board);
      board = reply;
    }
  }
  const owners = territory(board);
  const won = area(board, "X", owners) > area(board, "O", owners) + 5.5;
  if (!won && process.env.GO_DEBUG) console.log(seed, moves, area(board, "X", owners), area(board, "O", owners), "\n" + board.join("\n"));
  return { won, moves };
}

describe("self-play against a random opponent", () => {
  it("wins nearly every 7x7 game, and every game ends", () => {
    const results = Array.from({ length: 20 }, (_, i) => game(7, i + 1));
    expect(results.every((r) => r.moves < 7 * 7 * 4)).toBe(true);
    expect(results.filter((r) => r.won).length).toBeGreaterThanOrEqual(18);
  });
});
