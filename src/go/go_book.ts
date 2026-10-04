import { Board } from "go/go_engine";

/**
 * The opening book: for our first BOOK_TURNS moves, which move did best
 * from each position, learned from our own games against each opponent.
 *
 * Go has no preferred orientation, so a position and its seven rotations
 * and reflections are one entry: each board is stored in canonical form
 * (the smallest of its eight transforms) and moves in that same frame.
 * Illuminati plays nearly the same move every time, so openings repeat
 * and the book converges quickly.
 *
 * Moves are chosen by UCB1 over the engine's top candidates: each is
 * tried once, then the best average outcome wins, with a little room left
 * for a candidate whose few results were unlucky.
 */
export const BOOK_TURNS = 2;
export const BOOK_CANDIDATES = 3;
const EXPLORATION = 0.5;
// Positions kept per book file; the least-played go first.
export const MAX_POSITIONS = 5000;

export const GO_BOOK_PATH = "/var/go_book.txt";
// [games, total value]
export type MoveStats = [number, number];
export type GoBookFile = { v: 1; positions: Record<string, Record<string, MoveStats>> };

export function emptyBook(): GoBookFile {
  return { v: 1, positions: {} };
}

export function parseBook(raw: string): GoBookFile {
  try {
    const book = JSON.parse(raw || "null") as GoBookFile | null;
    return book && book.v === 1 && typeof book.positions === "object" ? book : emptyBook();
  } catch {
    return emptyBook();
  }
}

/** The eight symmetries of a square board, as point maps for side length n. */
export const TRANSFORMS: ((x: number, y: number, n: number) => [number, number])[] = [
  (x, y) => [x, y],
  (x, y, n) => [y, n - 1 - x],
  (x, y, n) => [n - 1 - x, n - 1 - y],
  (x, y, n) => [n - 1 - y, x],
  (x, y, n) => [n - 1 - x, y],
  (x, y, n) => [x, n - 1 - y],
  (x, y) => [y, x],
  (x, y, n) => [n - 1 - y, n - 1 - x],
];

/** The board under transform `t`. */
export function transformBoard(board: Board, t: number): Board {
  const n = board.length;
  const out: string[][] = Array.from({ length: n }, () => Array<string>(n).fill("#"));
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const [tx, ty] = TRANSFORMS[t](x, y, n);
      out[tx][ty] = board[x][y];
    }
  }
  return out.map((column) => column.join(""));
}

/** The canonical form of a square board and the transform that produces it. */
export function canonical(board: Board): { key: string; transform: number } {
  let best = { key: "", transform: 0 };
  for (let t = 0; t < TRANSFORMS.length; t++) {
    const key = transformBoard(board, t).join("/");
    if (best.key === "" || key < best.key) best = { key, transform: t };
  }
  return best;
}

/** A move's key in the canonical frame of `transform`. */
export function moveKey(x: number, y: number, n: number, transform: number): string {
  const [tx, ty] = TRANSFORMS[transform](x, y, n);
  return `${tx},${ty}`;
}

/** The book entry for a position: the board's canonical key, prefixed by opponent. */
export function positionKey(opponent: string, canonicalKey: string): string {
  return `${opponent}|${canonicalKey}`;
}

/**
 * The candidate to play (an index into `candidates`, the engine's moves
 * best first): an untried one before any repeat, then the best upper
 * confidence bound on average value. Values are normalized by the best
 * average so the exploration term means the same at any score scale.
 */
export function pickBookMove(candidateKeys: string[], stats: Record<string, MoveStats> | undefined): number {
  if (candidateKeys.length === 0) return -1;
  const seen = candidateKeys.map((k) => stats?.[k] ?? ([0, 0] as MoveStats));
  const untried = seen.findIndex(([games]) => games === 0);
  if (untried !== -1) return untried;
  const total = seen.reduce((sum, [games]) => sum + games, 0);
  const means = seen.map(([games, value]) => value / games);
  const scale = Math.max(1e-9, ...means.map(Math.abs));
  let best = 0;
  let bestBound = -Infinity;
  seen.forEach(([games], i) => {
    const bound = means[i] / scale + EXPLORATION * Math.sqrt(Math.log(total) / games);
    if (bound > bestBound) {
      bestBound = bound;
      best = i;
    }
  });
  return best;
}

/** The book with one finished game's opening moves credited with `value`. */
export function recordOpening(book: GoBookFile, moves: { position: string; move: string }[], value: number): GoBookFile {
  const positions = { ...book.positions };
  for (const { position, move } of moves) {
    const entry = { ...(positions[position] ?? {}) };
    const [games, total] = entry[move] ?? [0, 0];
    entry[move] = [games + 1, total + value];
    positions[position] = entry;
  }
  return { ...book, positions: prunePositions(positions, MAX_POSITIONS) };
}

/** At most `max` positions, keeping the most-played. */
export function prunePositions(positions: Record<string, Record<string, MoveStats>>, max: number): Record<string, Record<string, MoveStats>> {
  const keys = Object.keys(positions);
  if (keys.length <= max) return positions;
  const played = (k: string): number => Object.values(positions[k]).reduce((sum, [games]) => sum + games, 0);
  return Object.fromEntries(
    keys
      .sort((a, b) => played(b) - played(a))
      .slice(0, max)
      .map((k) => [k, positions[k]])
  );
}

/**
 * What a game was worth for the book: its node power with the streak
 * multiplier fixed (a win at 1.25, a loss at 0.5) - the streak depends on
 * earlier games, not this opening.
 */
export function openingValue(blackScore: number, difficulty: number, won: boolean): number {
  return blackScore * difficulty * (won ? 1.25 : 0.5);
}
