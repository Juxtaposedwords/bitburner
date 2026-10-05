/**
 * IPvGO board rules, pure (no ns): chains, liberties, captures, legality
 * and area. The game's own analysis calls cost 8-16 GB each; these work
 * from ns.go.getBoardState() (4 GB) and getMoveHistory() (0 GB).
 *
 * A board is the game's format: one string per column, board[x][y], with
 * "X" black (us), "O" white, "." empty and "#" a dead node (off the board).
 * Boards are never changed once made, so each one's numeric form (Grid:
 * one byte per point, neighbor lists computed once per board size) is made
 * once and reused. Working on strings - an "x,y" key, a neighbor array and
 * a Map entry per point visited - took ~40% of move-choice time, plus ~10%
 * in garbage collection.
 */
export type Board = string[];
export type Stone = "X" | "O";
export type Point = [number, number];

export function opponentOf(color: Stone): Stone {
  return color === "X" ? "O" : "X";
}

export function at(board: Board, x: number, y: number): string {
  return board[x]?.[y] ?? "#";
}

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const DEAD = 3;
const CODE: Record<string, number> = { ".": EMPTY, X: BLACK, O: WHITE, "#": DEAD };
const CHAR = [".", "X", "O", "#"];
const codeOf = (color: string): number => CODE[color] ?? DEAD;

/** Neighbor lists for a board shape: point i = x*height + y; its on-grid neighbors are nbList[nbStart[i] .. nbStart[i+1]). */
type Shape = { width: number; height: number; nbStart: Int32Array; nbList: Int32Array };
const shapes = new Map<string, Shape>();

function shapeOf(width: number, height: number): Shape {
  const k = `${width}x${height}`;
  let shape = shapes.get(k);
  if (!shape) {
    const nbStart = new Int32Array(width * height + 1);
    const list: number[] = [];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        nbStart[x * height + y] = list.length;
        if (x + 1 < width) list.push((x + 1) * height + y);
        if (x > 0) list.push((x - 1) * height + y);
        if (y + 1 < height) list.push(x * height + y + 1);
        if (y > 0) list.push(x * height + y - 1);
      }
    }
    nbStart[width * height] = list.length;
    shape = { width, height, nbStart, nbList: Int32Array.from(list) };
    shapes.set(k, shape);
  }
  return shape;
}

type Grid = { shape: Shape; cells: Uint8Array };
const grids = new WeakMap<Board, Grid>();

/** The board's numeric form, made once per board. */
function gridOf(board: Board): Grid {
  let grid = grids.get(board);
  if (!grid) {
    const width = board.length;
    const height = width > 0 ? board[0].length : 0;
    const shape = shapeOf(width, height);
    const cells = new Uint8Array(width * height);
    for (let x = 0; x < width; x++) {
      const column = board[x];
      for (let y = 0; y < height; y++) cells[x * height + y] = codeOf(column[y]);
    }
    grid = { shape, cells };
    grids.set(board, grid);
  }
  return grid;
}

const pointOf = (i: number, height: number): Point => [Math.floor(i / height), i % height];
const key = (x: number, y: number): string => `${x},${y}`;

/** The on-board orthogonal neighbors of (x, y) - dead nodes and edges excluded. */
export function neighbors(board: Board, x: number, y: number): Point[] {
  const { shape, cells } = gridOf(board);
  if (x < 0 || x >= shape.width || y < 0 || y >= shape.height) return [];
  const out: Point[] = [];
  const i = x * shape.height + y;
  for (let k = shape.nbStart[i]; k < shape.nbStart[i + 1]; k++) {
    const n = shape.nbList[k];
    if (cells[n] !== DEAD) out.push(pointOf(n, shape.height));
  }
  return out;
}

// Flood-fill scratch, reused: a point is "seen" in the current fill when
// its stamp equals the fill's id (no clearing between fills).
let stamp = new Int32Array(0);
let stampId = 0;
let stack = new Int32Array(0);

function scratch(size: number): void {
  if (stamp.length < size) {
    stamp = new Int32Array(size);
    stack = new Int32Array(size);
    stampId = 0;
  }
  stampId++;
  if (stampId > 2_000_000_000) {
    stamp.fill(0);
    stampId = 1;
  }
}

/**
 * Floods the same-value group containing point `start`: calls `onMember`
 * for each point in it and `onBorder` for each neighbor outside it.
 */
function flood(shape: Shape, cells: Uint8Array, start: number, onMember: (i: number) => void, onBorder: (n: number) => void): void {
  scratch(cells.length);
  const id = stampId;
  const value = cells[start];
  let top = 0;
  stack[top++] = start;
  stamp[start] = id;
  while (top > 0) {
    const i = stack[--top];
    onMember(i);
    for (let k = shape.nbStart[i]; k < shape.nbStart[i + 1]; k++) {
      const n = shape.nbList[k];
      if (cells[n] === DEAD) continue;
      if (cells[n] === value) {
        if (stamp[n] !== id) {
          stamp[n] = id;
          stack[top++] = n;
        }
      } else {
        onBorder(n);
      }
    }
  }
}

// Liberty-counting scratch, reused like the flood's (a fresh id per count).
let libStamp = new Int32Array(0);
let libStampId = 0;

/** How many distinct empty points border the chain containing point `start`. */
function libertyCount(shape: Shape, cells: Uint8Array, start: number, seenLib: Int32Array, libId: number): number {
  let libs = 0;
  flood(
    shape,
    cells,
    start,
    () => undefined,
    (n) => {
      if (cells[n] === EMPTY && seenLib[n] !== libId) {
        seenLib[n] = libId;
        libs++;
      }
    }
  );
  return libs;
}

export type Chain = { color: string; stones: Point[]; liberties: Set<string> };

/** The connected group of same-color points containing (x, y), with its liberties (for a stone chain). */
export function chainAt(board: Board, x: number, y: number): Chain {
  const color = at(board, x, y);
  const { shape, cells } = gridOf(board);
  const stones: Point[] = [];
  const liberties = new Set<string>();
  if (x < 0 || x >= shape.width || y < 0 || y >= shape.height || color === "#") return { color, stones: [[x, y]], liberties };
  flood(
    shape,
    cells,
    x * shape.height + y,
    (i) => stones.push(pointOf(i, shape.height)),
    (n) => {
      if (cells[n] === EMPTY) {
        const [nx, ny] = pointOf(n, shape.height);
        liberties.add(key(nx, ny));
      }
    }
  );
  return { color, stones, liberties };
}

/** Every stone chain of `color` on the board. */
export function chainsOf(board: Board, color: Stone): Chain[] {
  const { shape, cells } = gridOf(board);
  const code = codeOf(color);
  const done = new Uint8Array(cells.length);
  const chains: Chain[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== code || done[i]) continue;
    const [x, y] = pointOf(i, shape.height);
    const chain = chainAt(board, x, y);
    for (const [sx, sy] of chain.stones) done[sx * shape.height + sy] = 1;
    chains.push(chain);
  }
  return chains;
}

// Boards joined into one string, for comparing positions (superko).
const flatKeys = new WeakMap<Board, string>();
function flatOf(board: Board): string {
  let flat = flatKeys.get(board);
  if (flat === undefined) {
    flat = board.join("|");
    flatKeys.set(board, flat);
  }
  return flat;
}

/**
 * The board after `color` plays (x, y): opponent chains left without
 * liberties are removed. undefined when the move is illegal - occupied,
 * off the board, suicide, or (with `history`) repeating an earlier board
 * (the game uses superko).
 */
export function play(board: Board, x: number, y: number, color: Stone, history: Board[] = []): Board | undefined {
  if (at(board, x, y) !== ".") return undefined;
  const { shape, cells: before } = gridOf(board);
  const cells = before.slice();
  const i = x * shape.height + y;
  const mine = codeOf(color);
  const enemy = mine === BLACK ? WHITE : BLACK;
  cells[i] = mine;

  if (libStamp.length < cells.length) libStamp = new Int32Array(cells.length);
  const seenLib = libStamp;
  const changedColumns = new Set<number>([x]);
  for (let k = shape.nbStart[i]; k < shape.nbStart[i + 1]; k++) {
    const n = shape.nbList[k];
    if (cells[n] !== enemy) continue;
    if (libertyCount(shape, cells, n, seenLib, ++libStampId) > 0) continue;
    const captured: number[] = [];
    flood(
      shape,
      cells,
      n,
      (m) => captured.push(m),
      () => undefined
    );
    for (const m of captured) {
      cells[m] = EMPTY;
      changedColumns.add(Math.floor(m / shape.height));
    }
  }
  if (libertyCount(shape, cells, i, seenLib, ++libStampId) === 0) return undefined;

  const next = board.slice();
  for (const column of changedColumns) {
    let s = "";
    for (let yy = 0; yy < shape.height; yy++) s += CHAR[cells[column * shape.height + yy]];
    next[column] = s;
  }
  grids.set(next, { shape, cells });
  if (history.length > 0) {
    const flat = flatOf(next);
    for (const prior of history) if (flatOf(prior) === flat) return undefined;
  }
  return next;
}

export function countStones(board: Board, color: Stone): number {
  const { cells } = gridOf(board);
  const code = codeOf(color);
  let count = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] === code) count++;
  return count;
}

/**
 * Who owns each empty point: an empty region bordered only by one color
 * belongs to it (as the game scores territory); "?" when both or neither.
 * Keyed "x,y".
 */
export function territory(board: Board): Map<string, Stone | "?"> {
  const { shape, cells } = gridOf(board);
  const owner = new Map<string, Stone | "?">();
  const done = new Uint8Array(cells.length);
  const region: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== EMPTY || done[i]) continue;
    region.length = 0;
    let borders = 0;
    flood(
      shape,
      cells,
      i,
      (m) => region.push(m),
      (n) => {
        if (cells[n] === BLACK) borders |= 1;
        else if (cells[n] === WHITE) borders |= 2;
      }
    );
    const who: Stone | "?" = borders === 1 ? "X" : borders === 2 ? "O" : "?";
    for (const m of region) {
      done[m] = 1;
      const [mx, my] = pointOf(m, shape.height);
      owner.set(key(mx, my), who);
    }
  }
  return owner;
}

/**
 * Who each empty point leans to: the color of the nearest stone, walking
 * through empty points only (a multi-source BFS); "?" when both colors
 * reach it at the same distance, or neither does. Unlike territory(), an
 * open region full of the opponent's loose stones isn't simply theirs.
 */
export function influence(board: Board): Map<string, Stone | "?"> {
  const { shape, cells } = gridOf(board);
  const { dist, lean } = influenceOf(board);
  const owner = new Map<string, Stone | "?">();
  for (let i = 0; i < cells.length; i++) {
    if (dist[i] === -1) continue;
    const [x, y] = pointOf(i, shape.height);
    owner.set(key(x, y), lean[i] === BLACK ? "X" : lean[i] === WHITE ? "O" : "?");
  }
  return owner;
}

/**
 * area(board, me, influence(board)) - area(board, enemy, influence(board)),
 * counted straight from the numeric form - the position evaluation's hot
 * path, without building a map of every point.
 */
export function influenceBalance(board: Board, me: Stone): number {
  const { cells } = gridOf(board);
  const { dist, lean } = influenceOf(board);
  const mine = codeOf(me);
  let balance = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const side = c === BLACK || c === WHITE ? c : dist[i] !== -1 ? lean[i] : 0;
    if (side === mine) balance++;
    else if (side === BLACK || side === WHITE) balance--;
  }
  return balance;
}

const influences = new WeakMap<Board, { dist: Int32Array; lean: Uint8Array }>();

/** Distance to the nearest stone and which color leans each empty point (1 black, 2 white, 3 both), once per board. */
function influenceOf(board: Board): { dist: Int32Array; lean: Uint8Array } {
  const cached = influences.get(board);
  if (cached) return cached;
  const { shape, cells } = gridOf(board);
  const size = cells.length;
  const dist = new Int32Array(size).fill(-1);
  // 1 black, 2 white, 3 contested.
  const lean = new Uint8Array(size);
  let frontier: number[] = [];
  for (let i = 0; i < size; i++) {
    const c = cells[i];
    if (c !== BLACK && c !== WHITE) continue;
    for (let k = shape.nbStart[i]; k < shape.nbStart[i + 1]; k++) {
      const n = shape.nbList[k];
      if (cells[n] !== EMPTY) continue;
      if (dist[n] === -1) {
        dist[n] = 1;
        lean[n] = c;
        frontier.push(n);
      } else if (dist[n] === 1 && lean[n] !== c) {
        lean[n] = 3;
      }
    }
  }
  for (let d = 2; frontier.length > 0; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const from = lean[i];
      for (let k = shape.nbStart[i]; k < shape.nbStart[i + 1]; k++) {
        const n = shape.nbList[k];
        if (cells[n] !== EMPTY) continue;
        if (dist[n] === -1) {
          dist[n] = d;
          lean[n] = from;
          next.push(n);
        } else if (dist[n] === d && lean[n] !== from) {
          lean[n] = 3;
        }
      }
    }
    frontier = next;
  }
  const result = { dist, lean };
  influences.set(board, result);
  return result;
}

/** Area score for `color`: its stones plus the empty points it alone borders (komi not included). */
export function area(board: Board, color: Stone, owners: Map<string, Stone | "?"> = territory(board)): number {
  let points = countStones(board, color);
  for (const who of owners.values()) if (who === color) points++;
  return points;
}

export function emptyPoints(board: Board): Point[] {
  const { shape, cells } = gridOf(board);
  const out: Point[] = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] === EMPTY) out.push(pointOf(i, shape.height));
  return out;
}

export { key as pointKey };
