import { area, Board, chainAt, chainsOf, countStones, emptyPoints, influence, neighbors, opponentOf, play, pointKey, Stone, territory } from "go/go_engine";

/**
 * Move choice and opponent choice for go_daemon.ts - pure, so both are
 * tested without the game.
 *
 * The move is a one-ply evaluation of every legal point: captures and
 * rescues first, then threats, then the change in area (stones plus
 * territory, as the game scores). Moves that only fill our own territory,
 * put our own chain in atari, or drop a weak stone inside the opponent's
 * territory are skipped; with nothing worth playing, we pass.
 */

const CAPTURE_WEIGHT = 10;
const RESCUE_WEIGHT = 8;
const ATARI_WEIGHT = 3;
const LIBERTY_WEIGHT = 0.5;
// Per enemy stone next to the move, divided by that chain's liberties left.
const PRESSURE_WEIGHT = 1;
// Below this many stones on the board, prefer points away from the edge.
const OPENING_STONES = 4;

export type MoveChoice = { kind: "move"; x: number; y: number; score: number } | { kind: "pass" };

/** The score of `me` playing (x, y), or undefined when it's illegal or not worth playing at all. */
export function evaluateMove(board: Board, x: number, y: number, me: Stone, history: Board[] = []): number | undefined {
  const next = play(board, x, y, me, history);
  if (!next) return undefined;
  const enemy = opponentOf(me);
  const ownersBefore = territory(board);

  const captured = countStones(board, enemy) - countStones(next, enemy);
  const mine = chainAt(next, x, y);
  const libs = mine.liberties.size;

  // Chains of ours next to the move that were in atari and now share a
  // chain with two or more liberties.
  let rescued = 0;
  const seenOwn = new Set<string>();
  for (const [nx, ny] of neighbors(board, x, y)) {
    if (board[nx][ny] !== me || seenOwn.has(pointKey(nx, ny))) continue;
    const before = chainAt(board, nx, ny);
    for (const [sx, sy] of before.stones) seenOwn.add(pointKey(sx, sy));
    if (before.liberties.size === 1 && libs >= 2) rescued += before.stones.length;
  }

  if (captured === 0 && rescued === 0) {
    if (libs === 1) return undefined;
    const ownerHere = ownersBefore.get(pointKey(x, y));
    if (ownerHere === me) return undefined;
    if (ownerHere === enemy && libs <= 2) return undefined;
  }

  // Enemy chains next to the move left with a single liberty, and
  // pressure on every enemy chain it touches.
  let threatened = 0;
  let pressure = 0;
  const seenEnemy = new Set<string>();
  for (const [nx, ny] of neighbors(next, x, y)) {
    if (next[nx][ny] !== enemy || seenEnemy.has(pointKey(nx, ny))) continue;
    const chain = chainAt(next, nx, ny);
    for (const [sx, sy] of chain.stones) seenEnemy.add(pointKey(sx, sy));
    if (chain.liberties.size === 1 && libs >= 2) threatened += chain.stones.length;
    if (libs >= 2) pressure += chain.stones.length / Math.max(1, chain.liberties.size);
  }

  // Area by influence (nearest stone), not strict borders: what the board
  // is heading toward, so open space counts before it's walled in.
  const balance = (b: Board): number => {
    const owners = influence(b);
    return area(b, me, owners) - area(b, enemy, owners);
  };
  const areaGain = balance(next) - balance(board);

  let score = CAPTURE_WEIGHT * captured + RESCUE_WEIGHT * rescued + ATARI_WEIGHT * threatened + PRESSURE_WEIGHT * pressure + areaGain + LIBERTY_WEIGHT * Math.min(libs, 4);
  if (libs === 2 && captured === 0) score -= 1;
  const stones = board.join("").replace(/[.#]/g, "").length;
  if (stones < OPENING_STONES) {
    const size = board.length;
    const edge = Math.min(x, y, size - 1 - x, (board[x]?.length ?? size) - 1 - y);
    score += edge >= 1 ? 1 : -1;
  }
  return score;
}

/** The best move for `me`, or a pass when nothing scores above zero. Ties go to the first point found. */
export function chooseMove(board: Board, me: Stone, history: Board[] = []): MoveChoice {
  return rankMoves(board, me, history)[0] ?? { kind: "pass" };
}

/** Every move scoring above zero, best first (ties in board order) - the opening book's candidates. */
export function rankMoves(board: Board, me: Stone, history: Board[] = []): { kind: "move"; x: number; y: number; score: number }[] {
  const moves: { kind: "move"; x: number; y: number; score: number }[] = [];
  for (const [x, y] of emptyPoints(board)) {
    const score = evaluateMove(board, x, y, me, history);
    if (score !== undefined && score > 0) moves.push({ kind: "move", x, y, score });
  }
  return moves.sort((a, b) => b.score - a.score);
}

// Stones of a chain left in atari count this much against its owner in a
// searched position - one more move captures them.
const ATARI_PENALTY = 2;
// Per separate chain: loose stones die on a small board, so connecting is
// worth something (benchmarked: 2-8 all cut wipe-outs by half; 3 chosen).
const CHAIN_PENALTY = 3;

/**
 * Eyes of a chain: its empty neighbors whose every on-board neighbor is
 * one of the chain's color. Two make a group that can't be captured.
 */
export function eyesOf(board: Board, chain: { color: string; liberties: Set<string> }): number {
  let eyes = 0;
  for (const point of chain.liberties) {
    const [x, y] = point.split(",").map(Number);
    if (neighbors(board, x, y).every(([nx, ny]) => board[nx][ny] === chain.color)) eyes++;
  }
  return eyes;
}

/** How safe a chain is, per stone: alive with two eyes, in danger with few liberties. */
function chainSafety(board: Board, chain: { color: string; stones: unknown[]; liberties: Set<string> }): number {
  const stones = chain.stones.length;
  if (eyesOf(board, chain) >= 2) return stones;
  const libs = chain.liberties.size;
  if (libs <= 1) return -ATARI_PENALTY * stones;
  if (libs === 2) return -0.5 * stones;
  return 0;
}

/** A position's value for `me`: area by influence, plus each side's group safety (eyes, liberties). */
export function evaluateBoard(board: Board, me: Stone): number {
  const enemy = opponentOf(me);
  const owners = influence(board);
  let value = area(board, me, owners) - area(board, enemy, owners);
  for (const chain of chainsOf(board, me)) value += chainSafety(board, chain) - CHAIN_PENALTY;
  for (const chain of chainsOf(board, enemy)) value -= chainSafety(board, chain) - CHAIN_PENALTY;
  return value;
}

/** Legal moves worth considering: not filling our own territory, not self-atari unless it captures. */
export function sensibleMoves(board: Board, me: Stone, history: Board[] = []): { x: number; y: number; next: Board }[] {
  const owners = territory(board);
  const enemy = opponentOf(me);
  const out: { x: number; y: number; next: Board }[] = [];
  for (const [x, y] of emptyPoints(board)) {
    if (owners.get(pointKey(x, y)) === me) continue;
    const next = play(board, x, y, me, history);
    if (!next) continue;
    if (chainAt(next, x, y).liberties.size === 1 && countStones(next, enemy) === countStones(board, enemy)) continue;
    out.push({ x, y, next });
  }
  return out;
}

/**
 * Full-width alpha-beta search to `depth` plies over sensibleMoves, with
 * evaluateBoard at the leaves; either side may pass. Passes when nothing
 * is sensible. Benchmarked on 5x5 with two white handicap stones and komi
 * 7.5, against the one-ply chooseMove as white (60 games): one-ply scored
 * 6.3 on average and was wiped out 22 times; depth 3 scores 9.8, is wiped
 * out 12 times and wins 10 (from 2), at ~8 ms a move (worst ~40 ms).
 */
export function chooseMoveMinimax(board: Board, me: Stone, history: Board[] = [], depth = 2): MoveChoice {
  const enemy = opponentOf(me);
  const search = (b: Board, h: Board[], toMove: Stone, plies: number, alpha: number, beta: number): number => {
    if (plies === 0) return evaluateBoard(b, me);
    const moves = sensibleMoves(b, toMove, h);
    // Passing is always allowed - the leaf as it stands.
    let best = toMove === me ? Math.max(alpha, evaluateBoard(b, me)) : Math.min(beta, evaluateBoard(b, me));
    for (const m of moves) {
      const v = search(m.next, [...h, b], opponentOf(toMove), plies - 1, toMove === me ? best : alpha, toMove === me ? beta : best);
      if (toMove === me ? v > best : v < best) best = v;
      if (toMove === me ? best >= beta : best <= alpha) break;
    }
    return best;
  };
  let best: MoveChoice = { kind: "pass" };
  let bestValue = -Infinity;
  for (const m of sensibleMoves(board, me, history)) {
    const v = search(m.next, [...history, board], enemy, depth - 1, bestValue, Infinity);
    if (v > bestValue) {
      bestValue = v;
      best = { kind: "move", x: m.x, y: m.y, score: v };
    }
  }
  return best;
}

export type GoConfig = {
  enabled: boolean;
  // Opponents in order of how much their bonus is worth to us (the game's
  // bonuses: Illuminati faster hack/grow/weaken, Daedalus reputation, The
  // Black Hand hacking money, Netburners hacknet production, Tetrads
  // combat stats, Slum Snakes crime success).
  opponents: string[];
  boardSize: 5 | 7 | 9 | 13;
  // An opponent we win less than this often (over at least minGames of
  // the recent results) is skipped for the next one in the list.
  minWinRate: number;
  minGames: number;
  // Plies the full-width search looks ahead (chooseMoveMinimax) on boards
  // up to searchMaxBoardSize; bigger boards use the one-ply chooseMove.
  searchDepth: number;
  searchMaxBoardSize: number;
};

export const DEFAULT_CONFIG: GoConfig = {
  enabled: true,
  opponents: ["Illuminati", "Daedalus", "The Black Hand", "Netburners", "Tetrads", "Slum Snakes"],
  boardSize: 7,
  minWinRate: 0.25,
  minGames: 10,
  searchDepth: 3,
  searchMaxBoardSize: 5,
};

// Recent results kept per opponent (true = win).
export const RESULT_WINDOW = 20;

export function recordResult(results: Record<string, boolean[]>, opponent: string, won: boolean): Record<string, boolean[]> {
  return { ...results, [opponent]: [...(results[opponent] ?? []), won].slice(-RESULT_WINDOW) };
}

/**
 * The opponent to play next: the first in priority order that's
 * available and not losing too often; when every one is, the one we beat
 * most often. undefined when none is available.
 */
export function pickOpponent(
  priority: string[],
  results: Record<string, boolean[]>,
  unavailable: Set<string>,
  minGames: number,
  minWinRate: number
): string | undefined {
  const available = priority.filter((name) => !unavailable.has(name));
  const winRate = (name: string): number => {
    const r = results[name] ?? [];
    return r.length === 0 ? 1 : r.filter(Boolean).length / r.length;
  };
  const winnable = available.find((name) => (results[name]?.length ?? 0) < minGames || winRate(name) >= minWinRate);
  if (winnable) return winnable;
  return [...available].sort((a, b) => winRate(b) - winRate(a))[0];
}

/**
 * The game's difficulty multiplier on node power (Go/effects/effect.ts):
 * (komi + 0.5) / 4, except a fixed 8 for a 5x5 board against Illuminati
 * (komi 7.5) - four times its usual 2. That board starts with two
 * handicap stones and is nearly unwinnable, but a loss still pays half.
 */
export const ILLUMINATI_KOMI = 7.5;
export function difficultyMultiplier(komi: number, boardSize: number): number {
  return boardSize === 5 && komi === ILLUMINATI_KOMI ? 8 : (komi + 0.5) * 0.25;
}

/** The game's win-streak multiplier: 0.5 for a loss, more for a streak or for breaking a losing one. */
export function winStreakMultiplier(winStreak: number, previousWinStreak: number): number {
  if (winStreak < 0) return 0.5;
  if (previousWinStreak < 0 && winStreak > 0) return 1 + 0.5 * Math.min(-previousWinStreak, 8);
  return 1 + 0.25 * Math.min(winStreak, 8);
}

/** Node power a finished game adds: our score (stones + territory) times both multipliers. */
export function nodePowerGained(blackScore: number, komi: number, boardSize: number, winStreak: number, previousWinStreak: number): number {
  return blackScore * difficultyMultiplier(komi, boardSize) * winStreakMultiplier(winStreak, previousWinStreak);
}

export const GO_STATUS_PATH = "/var/go_status.txt";
export const GO_STATE_PATH = "/var/go_state.txt";

export type GoStateFile = { results: Record<string, boolean[]>; nodeReset?: number };

export type GoStatusFile = {
  opponent?: string;
  boardSize: number;
  bonuses: Record<string, { wins: number; losses: number; winStreak: number; bonusPercent: number; bonusDescription: string }>;
  recent: Record<string, string>;
  writtenAt: number;
};

/** "7/10 won" for an opponent's recent results. */
export function describeResults(results: boolean[]): string {
  return `${results.filter(Boolean).length}/${results.length} won`;
}
