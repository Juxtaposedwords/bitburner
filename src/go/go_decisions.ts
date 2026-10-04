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

/**
 * What a searched position's score weighs (evaluateBoard) - one set per
 * opponent style (go_strategy.ts).
 */
export type EvalWeights = {
  // Per point of area by influence (ours minus theirs).
  area: number;
  // Per separate chain: loose stones die on a small board, so connecting
  // is worth something (benchmarked: 2-8 all cut wipe-outs by half).
  chain: number;
  // Per stone in a chain with one liberty - one more move captures it.
  atari: number;
  // Per stone in a chain with two liberties.
  shortOfLiberties: number;
  // Per stone in a chain with two eyes (can't be captured).
  alive: number;
  // How much the opponent's chain safety counts against them, relative to
  // ours: above 1 hunts their weak groups, below 1 plays safe.
  aggression: number;
};

export const DEFAULT_WEIGHTS: EvalWeights = { area: 1, chain: 3, atari: 2, shortOfLiberties: 0.5, alive: 1, aggression: 1 };

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

/** How safe a chain is: alive with two eyes, in danger with few liberties, less the cost of being a separate chain. */
function chainSafety(board: Board, chain: { color: string; stones: unknown[]; liberties: Set<string> }, w: EvalWeights): number {
  const stones = chain.stones.length;
  let value = -w.chain;
  if (eyesOf(board, chain) >= 2) return value + w.alive * stones;
  const libs = chain.liberties.size;
  if (libs <= 1) value -= w.atari * stones;
  else if (libs === 2) value -= w.shortOfLiberties * stones;
  return value;
}

/** A position's value for `me`: area by influence, plus each side's group safety (eyes, liberties, connection). */
export function evaluateBoard(board: Board, me: Stone, w: EvalWeights = DEFAULT_WEIGHTS): number {
  const enemy = opponentOf(me);
  const owners = influence(board);
  let value = w.area * (area(board, me, owners) - area(board, enemy, owners));
  for (const chain of chainsOf(board, me)) value += chainSafety(board, chain, w);
  for (const chain of chainsOf(board, enemy)) value -= w.aggression * chainSafety(board, chain, w);
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
export function chooseMoveMinimax(board: Board, me: Stone, history: Board[] = [], depth = 2, w: EvalWeights = DEFAULT_WEIGHTS): MoveChoice {
  const enemy = opponentOf(me);
  const search = (b: Board, h: Board[], toMove: Stone, plies: number, alpha: number, beta: number): number => {
    if (plies === 0) return evaluateBoard(b, me, w);
    const moves = sensibleMoves(b, toMove, h);
    // Passing is always allowed - the leaf as it stands.
    let best = toMove === me ? Math.max(alpha, evaluateBoard(b, me, w)) : Math.min(beta, evaluateBoard(b, me, w));
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
  boardSize: 5 | 7 | 9 | 13;
  // Plies the full-width search looks ahead (chooseMoveMinimax) on boards
  // up to searchMaxBoardSize; bigger boards use the one-ply chooseMove.
  searchDepth: number;
  searchMaxBoardSize: number;
  // Overrides for the phase's opponent weights (system/phase.ts's
  // goWeights), e.g. {"Netburners": 0} to stop playing them.
  opponentWeights: Record<string, number>;
};

export const DEFAULT_CONFIG: GoConfig = {
  enabled: true,
  boardSize: 5,
  searchDepth: 3,
  searchMaxBoardSize: 5,
  opponentWeights: {},
};

// Recent results kept per opponent (true = win), for the status file.
export const RESULT_WINDOW = 20;

export function recordResult(results: Record<string, boolean[]>, opponent: string, won: boolean): Record<string, boolean[]> {
  return { ...results, [opponent]: [...(results[opponent] ?? []), won].slice(-RESULT_WINDOW) };
}

/**
 * Each opponent's komi (its difficulty) and bonus power (what its node
 * power is worth), from the game's Go/Constants.ts; and the node power a
 * 5x5 game against it is worth with our first strategy (go_strategy.ts),
 * measured over 60 games against the real AI in gosim/ (streak part fixed:
 * x1.25 a win, x0.5 a loss) - the prior until our own games say otherwise.
 */
export const OPPONENTS: Record<string, { komi: number; bonusPower: number; powerPerGame5x5: number }> = {
  Netburners: { komi: 1.5, bonusPower: 1.3, powerPerGame5x5: 12.5 },
  "Slum Snakes": { komi: 3.5, bonusPower: 1.2, powerPerGame5x5: 24.0 },
  "The Black Hand": { komi: 3.5, bonusPower: 0.9, powerPerGame5x5: 23.8 },
  Tetrads: { komi: 5.5, bonusPower: 0.7, powerPerGame5x5: 31.3 },
  Daedalus: { komi: 5.5, bonusPower: 1.1, powerPerGame5x5: 34.2 },
  Illuminati: { komi: 7.5, bonusPower: 0.7, powerPerGame5x5: 125.8 },
};

/**
 * The bonus (a fraction, before the BitNode's and Source-File's
 * multipliers) that `power` node power gives - the game's CalculateEffect.
 * It flattens as power grows, so a fresh opponent soon pays more per game
 * than one already built up.
 */
export function bonusFor(power: number, bonusPower: number): number {
  return Math.log(power + 1) * Math.pow(power + 1, 0.3) * 0.002 * bonusPower;
}

/**
 * Per opponent: node power and games since the last install (the game
 * zeroes both on every install), and all-time totals for what a game is
 * worth and how long it takes.
 */
export type OpponentRecord = { games: number; power: number; totalGames: number; totalPower: number; totalSeconds: number };

// Until an opponent has been played: on 5x5 the benchmarked power per game
// (OPPONENTS), otherwise a score of 8; 10 seconds a game. Weighted as this
// many games - enough that one odd game (a leftover finished in a second
// for 0 power) doesn't rule an opponent out: that kept Illuminati, worth
// the most per game, unplayed.
const PRIOR_SCORE = 8;
const PRIOR_SECONDS = 10;
const PRIOR_GAMES = 5;

/** Node power held now: the record's, unless the game's count of games played shows an install since. */
export function powerNow(record: OpponentRecord | undefined, gamesPlayed: number): number {
  return record && gamesPlayed >= record.games ? record.power : 0;
}

/**
 * The opponent to play next: the most weighted bonus gained per second -
 * weight x (bonus after one more average game - bonus now) / average game
 * length. `gamesPlayed` is the game's own count per opponent (wins +
 * losses), which catches installs. undefined when no weighted opponent is
 * available.
 */
export function pickOpponentByValue(
  weights: Record<string, number>,
  records: Record<string, OpponentRecord>,
  gamesPlayed: Record<string, number>,
  unavailable: Set<string>,
  boardSize: number
): string | undefined {
  let best: string | undefined;
  let bestRate = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const details = OPPONENTS[name];
    if (!details || !(weight > 0) || unavailable.has(name)) continue;
    const record = records[name];
    // Measured averages, blended with the prior as PRIOR_GAMES games.
    const games = record?.totalGames ?? 0;
    const priorPower = boardSize === 5 ? details.powerPerGame5x5 : PRIOR_SCORE * difficultyMultiplier(details.komi, boardSize) * 0.5;
    const perGame = ((record?.totalPower ?? 0) + PRIOR_GAMES * priorPower) / (games + PRIOR_GAMES);
    const seconds = ((record?.totalSeconds ?? 0) + PRIOR_GAMES * PRIOR_SECONDS) / (games + PRIOR_GAMES);
    const power = powerNow(record, gamesPlayed[name] ?? 0);
    const rate = (weight * (bonusFor(power + perGame, details.bonusPower) - bonusFor(power, details.bonusPower))) / Math.max(1, seconds);
    if (rate > bestRate) {
      bestRate = rate;
      best = name;
    }
  }
  return best;
}

/** The records after a finished game; `gamesPlayed` is the game's count for that opponent including this one. */
export function recordGame(records: Record<string, OpponentRecord>, name: string, power: number, seconds: number, gamesPlayed: number): Record<string, OpponentRecord> {
  const record = records[name] ?? { games: 0, power: 0, totalGames: 0, totalPower: 0, totalSeconds: 0 };
  return {
    ...records,
    [name]: {
      games: gamesPlayed,
      power: powerNow(record, gamesPlayed - 1) + power,
      totalGames: record.totalGames + 1,
      totalPower: record.totalPower + power,
      totalSeconds: record.totalSeconds + seconds,
    },
  };
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

// strategies: per opponent, per go_strategy.ts strategy name, [games, total value].
export type GoStateFile = { results: Record<string, boolean[]>; records: Record<string, OpponentRecord>; strategies: Record<string, Record<string, [number, number]>> };

export type GoStatusFile = {
  opponent?: string;
  boardSize: number;
  bonuses: Record<string, { wins: number; losses: number; winStreak: number; bonusPercent: number; bonusDescription: string }>;
  recent: Record<string, string>;
  // Per opponent, per strategy: "average value over games".
  strategies: Record<string, Record<string, string>>;
  writtenAt: number;
};

/** "7/10 won" for an opponent's recent results. */
export function describeResults(results: boolean[]): string {
  return `${results.filter(Boolean).length}/${results.length} won`;
}
