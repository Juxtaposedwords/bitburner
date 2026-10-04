import { Board, chainAt, chainsOf, countStones, emptyPoints, neighbors, opponentOf, play, Point, pointKey, Stone, territory } from "go/go_engine";
import { chooseMove, eyesOf, MoveChoice } from "go/go_decisions";

/**
 * Stand-ins for the game's IPvGO opponents, for tuning our strategies
 * offline (go_strategy.ts, go_tune_test.ts). Each follows its faction's
 * priority list and random thresholds from the game's Go/boardAnalysis/
 * goAI.ts; the move kinds are approximations built on our own board rules
 * (the game's pattern moves aren't reproduced - contact moves stand in).
 * Not used by the daemon.
 */
export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

type Candidate = { x: number; y: number; next: Board };

function legal(board: Board, me: Stone, history: Board[]): Candidate[] {
  const owners = territory(board);
  const out: Candidate[] = [];
  for (const [x, y] of emptyPoints(board)) {
    if (owners.get(pointKey(x, y)) === me) continue;
    const next = play(board, x, y, me, history);
    if (next) out.push({ x, y, next });
  }
  return out;
}

const captured = (board: Board, next: Board, me: Stone): number => countStones(board, opponentOf(me)) - countStones(next, opponentOf(me));
const libsAt = (next: Board, x: number, y: number): number => chainAt(next, x, y).liberties.size;
// The game's "smart" filter: no move that lets the opponent capture it straight away.
const safe = (board: Board, c: Candidate, me: Stone): boolean => captured(board, c.next, me) > 0 || libsAt(c.next, c.x, c.y) > 1;
const pick = (moves: Candidate[], rng: Rng): Candidate | undefined => (moves.length === 0 ? undefined : moves[Math.floor(rng() * moves.length)]);

function captureMove(board: Board, moves: Candidate[], me: Stone): Candidate | undefined {
  let best: Candidate | undefined;
  let most = 0;
  for (const m of moves) {
    const n = captured(board, m.next, me);
    if (n > most) {
      most = n;
      best = m;
    }
  }
  return best;
}

/** Saves one of our chains in atari: a move after which it has two or more liberties. */
function defendMove(board: Board, moves: Candidate[], me: Stone): Candidate | undefined {
  const inAtari = chainsOf(board, me).filter((c) => c.liberties.size === 1);
  if (inAtari.length === 0) return undefined;
  const libs = new Set(inAtari.flatMap((c) => [...c.liberties]));
  return moves.find((m) => libs.has(pointKey(m.x, m.y)) && libsAt(m.next, m.x, m.y) >= 2) ?? moves.find((m) => captured(board, m.next, me) > 0);
}

/** Takes a liberty from an enemy chain with at most `maxLibs`, weakest first. */
function surroundMove(board: Board, moves: Candidate[], me: Stone, maxLibs: number, smart: boolean): Candidate | undefined {
  const targets = chainsOf(board, opponentOf(me))
    .filter((c) => c.liberties.size <= maxLibs)
    .sort((a, b) => a.liberties.size - b.liberties.size);
  for (const target of targets) {
    const m = moves.find((c) => target.liberties.has(pointKey(c.x, c.y)) && (!smart || safe(board, c, me)));
    if (m) return m;
  }
  return undefined;
}

const totalEyes = (board: Board, color: Stone): number => chainsOf(board, color).reduce((sum, c) => sum + eyesOf(board, c), 0);

function eyeCreationMove(board: Board, moves: Candidate[], me: Stone): Candidate | undefined {
  const before = totalEyes(board, me);
  let best: Candidate | undefined;
  let gain = 0;
  for (const m of moves) {
    const g = totalEyes(m.next, me) - before;
    if (g > gain && libsAt(m.next, m.x, m.y) > 1) {
      gain = g;
      best = m;
    }
  }
  return best;
}

/** Blocks the opponent's only move to a second eye. */
function eyeBlockMove(board: Board, moves: Candidate[], me: Stone, history: Board[]): Candidate | undefined {
  const enemy = opponentOf(me);
  const theirs = legal(board, enemy, history).filter((m) => chainsOf(m.next, enemy).some((c) => eyesOf(m.next, c) >= 2) && !chainsOf(board, enemy).some((c) => eyesOf(board, c) >= 2));
  if (theirs.length !== 1) return undefined;
  return moves.find((m) => m.x === theirs[0].x && m.y === theirs[0].y);
}

/** A corner point one in from both edges, while its corner is still empty. */
function cornerMove(board: Board, moves: Candidate[]): Candidate | undefined {
  const n = board.length;
  for (const [cx, cy] of [
    [1, 1],
    [1, n - 2],
    [n - 2, 1],
    [n - 2, n - 2],
  ]) {
    let empty = true;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (board[cx + dx]?.[cy + dy] !== ".") empty = false;
    if (!empty) continue;
    const m = moves.find((c) => c.x === cx && c.y === cy);
    if (m) return m;
  }
  return undefined;
}

const allEmptyAround = (board: Board, x: number, y: number): boolean => neighbors(board, x, y).every(([nx, ny]) => board[nx][ny] === ".");

function expansionMove(board: Board, moves: Candidate[], rng: Rng): Candidate | undefined {
  return pick(
    moves.filter((m) => allEmptyAround(board, m.x, m.y)),
    rng
  );
}

function jumpMove(board: Board, moves: Candidate[], me: Stone, rng: Rng): Candidate | undefined {
  const own: Point[] = [];
  for (let x = 0; x < board.length; x++) for (let y = 0; y < board[x].length; y++) if (board[x][y] === me) own.push([x, y]);
  return pick(
    moves.filter((m) => allEmptyAround(board, m.x, m.y) && own.some(([ox, oy]) => Math.abs(ox - m.x) + Math.abs(oy - m.y) <= 2)),
    rng
  );
}

/** Extends one of our chains to the point that gives it the most liberties. */
function growthMove(board: Board, moves: Candidate[], me: Stone, smart: boolean): Candidate | undefined {
  let best: Candidate | undefined;
  let most = 1;
  for (const m of moves) {
    if (!neighbors(board, m.x, m.y).some(([nx, ny]) => board[nx][ny] === me)) continue;
    if (smart && !safe(board, m, me)) continue;
    const libs = libsAt(m.next, m.x, m.y);
    if (libs > most) {
      most = libs;
      best = m;
    }
  }
  return best;
}

/** A move touching an enemy stone (standing in for the game's local patterns). */
function contactMove(board: Board, moves: Candidate[], me: Stone, rng: Rng): Candidate | undefined {
  return pick(
    moves.filter((m) => safe(board, m, me) && neighbors(board, m.x, m.y).some(([nx, ny]) => board[nx][ny] === opponentOf(me))),
    rng
  );
}

/**
 * The game's pattern moves (local shapes it matches) aren't reproduced;
 * our one-ply engine's choice stands in - calibrated so simulated Daedalus
 * wins about as often against our search as the real one does live.
 */
function patternMove(board: Board, me: Stone, history: Board[], moves: Candidate[]): Candidate | undefined {
  const choice = chooseMove(board, me, history);
  return choice.kind === "move" ? moves.find((m) => m.x === choice.x && m.y === choice.y) : undefined;
}

export type SimOpponent = (board: Board, me: Stone, history: Board[], rng: Rng) => MoveChoice;

const asChoice = (m: Candidate | undefined): MoveChoice | undefined => (m ? { kind: "move", x: m.x, y: m.y, score: 0 } : undefined);

function fallback(board: Board, moves: Candidate[], me: Stone, smart: boolean, rng: Rng): MoveChoice {
  const options = smart ? moves.filter((m) => safe(board, m, me)) : moves;
  return asChoice(growthMove(board, options, me, smart) ?? expansionMove(board, options, rng) ?? pick(options, rng)) ?? { kind: "pass" };
}

function illuminati(board: Board, me: Stone, history: Board[], rng: Rng): MoveChoice {
  const moves = legal(board, me, history);
  const r = rng();
  return (
    asChoice(
      captureMove(board, moves, me) ??
        defendMove(board, moves, me) ??
        eyeCreationMove(board, moves, me) ??
        surroundMove(board, moves, me, 1, true) ??
        eyeBlockMove(board, moves, me, history) ??
        cornerMove(board, moves) ??
        (r > 0.25 ? patternMove(board, me, history, moves) : undefined) ??
        (r > 0.4 ? jumpMove(board, moves, me, rng) : undefined) ??
        (r < 0.6 ? surroundMove(board, moves, me, 2, true) : undefined)
    ) ?? fallback(board, moves, me, true, rng)
  );
}

/** The six opponents, by the faction names the game uses. */
export const SIM_OPPONENTS: Record<string, SimOpponent> = {
  Netburners: (board, me, history, rng) => {
    const moves = legal(board, me, history);
    const r = rng();
    const choice =
      r < 0.2
        ? captureMove(board, moves, me) ?? defendMove(board, moves, me) ?? surroundMove(board, moves, me, 1, false)
        : r < 0.4
          ? expansionMove(board, moves, rng)
          : r < 0.6
            ? growthMove(board, moves, me, false)
            : r < 0.75
              ? pick(moves, rng)
              : undefined;
    return asChoice(choice) ?? fallback(board, moves, me, false, rng);
  },
  "Slum Snakes": (board, me, history, rng) => {
    const moves = legal(board, me, history);
    const smart = rng() < 0.3;
    const r = rng();
    const choice =
      defendMove(board, moves, me) ??
      (r < 0.2 ? captureMove(board, moves, me) ?? surroundMove(board, moves, me, 1, smart) : r < 0.6 ? growthMove(board, moves, me, smart) : r < 0.65 ? pick(moves, rng) : undefined);
    return asChoice(choice) ?? fallback(board, moves, me, smart, rng);
  },
  "The Black Hand": (board, me, history, rng) => {
    const moves = legal(board, me, history);
    const smart = rng() < 0.8;
    const r = rng();
    const choice =
      captureMove(board, moves, me) ??
      surroundMove(board, moves, me, 1, smart) ??
      defendMove(board, moves, me) ??
      surroundMove(board, moves, me, 2, smart) ??
      (r < 0.3 ? contactMove(board, moves, me, rng) : r < 0.75 ? surroundMove(board, moves, me, 3, smart) : undefined);
    return asChoice(choice) ?? fallback(board, moves, me, smart, rng);
  },
  Tetrads: (board, me, history, rng) => {
    const moves = legal(board, me, history);
    const choice =
      captureMove(board, moves, me) ??
      defendMove(board, moves, me) ??
      patternMove(board, me, history, moves) ??
      surroundMove(board, moves, me, 1, true) ??
      (rng() < 0.4 ? growthMove(board, moves, me, true) : undefined);
    return asChoice(choice) ?? fallback(board, moves, me, true, rng);
  },
  Daedalus: (board, me, history, rng) => {
    if (rng() < 0.9) return illuminati(board, me, history, rng);
    const moves = legal(board, me, history);
    return asChoice(pick(moves, rng)) ?? { kind: "pass" };
  },
  Illuminati: illuminati,
};

/** A fresh 5x5 board as the game deals it: 0-3 random dead nodes, and Illuminati's one handicap stone. */
export function simStartBoard(opponent: string, rng: Rng, size = 5): Board {
  const b = Array.from({ length: size }, () => ".".repeat(size).split(""));
  const dead = Math.floor(rng() * 4);
  for (let i = 0; i < dead; i++) b[Math.floor(rng() * size)][Math.floor(rng() * size)] = "#";
  if (opponent === "Illuminati") {
    const spots: Point[] = rng() < 0.2 ? [[2, 2]] : [[1, 1], [1, 3], [3, 1], [3, 3], [2, 2]];
    const free = spots.filter(([x, y]) => b[x][y] === ".");
    const [hx, hy] = free[Math.floor(rng() * free.length)] ?? [2, 2];
    b[hx][hy] = "O";
  }
  return b.map((c) => c.join(""));
}

export type SimPlayer = (board: Board, me: Stone, history: Board[]) => MoveChoice;

/** One game, us as black against a simulated opponent; the score is ours (stones + territory), the win after the opponent's komi. */
export function simGame(black: SimPlayer, opponent: string, komi: number, seed: number): { won: boolean; score: number } {
  const rng = seededRng(seed);
  const white = SIM_OPPONENTS[opponent];
  let board = simStartBoard(opponent, rng);
  const history: Board[] = [];
  let passes = 0;
  let turn: Stone = "X";
  for (let n = 0; passes < 2 && n < 150; n++) {
    const choice = turn === "X" ? black(board, turn, history) : white(board, turn, history, rng);
    if (choice.kind === "pass") passes++;
    else {
      passes = 0;
      history.push(board);
      board = play(board, choice.x, choice.y, turn, history) ?? board;
    }
    turn = opponentOf(turn);
  }
  const owners = territory(board);
  let score = countStones(board, "X");
  let theirs = countStones(board, "O") + komi;
  for (const who of owners.values()) {
    if (who === "X") score++;
    else if (who === "O") theirs++;
  }
  return { won: score > theirs, score };
}
