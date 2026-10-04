/**
 * IPvGO board rules, pure (no ns): chains, liberties, captures, legality
 * and area. The game's own analysis calls cost 8-16 GB each; these work
 * from ns.go.getBoardState() (4 GB) and getMoveHistory() (0 GB).
 *
 * A board is the game's format: one string per column, board[x][y], with
 * "X" black (us), "O" white, "." empty and "#" a dead node (off the board).
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

/** The on-board orthogonal neighbors of (x, y) - dead nodes and edges excluded. */
export function neighbors(board: Board, x: number, y: number): Point[] {
  const out: Point[] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < board.length && ny >= 0 && ny < board[nx].length && board[nx][ny] !== "#") out.push([nx, ny]);
  }
  return out;
}

const key = (x: number, y: number): string => `${x},${y}`;

export type Chain = { color: string; stones: Point[]; liberties: Set<string> };

/** The connected group of same-color points containing (x, y), with its liberties (for a stone chain). */
export function chainAt(board: Board, x: number, y: number): Chain {
  const color = at(board, x, y);
  const seen = new Set<string>([key(x, y)]);
  const stones: Point[] = [];
  const liberties = new Set<string>();
  const stack: Point[] = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop() as Point;
    stones.push([cx, cy]);
    for (const [nx, ny] of neighbors(board, cx, cy)) {
      const c = board[nx][ny];
      if (c === color) {
        if (!seen.has(key(nx, ny))) {
          seen.add(key(nx, ny));
          stack.push([nx, ny]);
        }
      } else if (c === ".") {
        liberties.add(key(nx, ny));
      }
    }
  }
  return { color, stones, liberties };
}

/** Every stone chain of `color` on the board. */
export function chainsOf(board: Board, color: Stone): Chain[] {
  const seen = new Set<string>();
  const chains: Chain[] = [];
  for (let x = 0; x < board.length; x++) {
    for (let y = 0; y < board[x].length; y++) {
      if (board[x][y] !== color || seen.has(key(x, y))) continue;
      const chain = chainAt(board, x, y);
      for (const [sx, sy] of chain.stones) seen.add(key(sx, sy));
      chains.push(chain);
    }
  }
  return chains;
}

function setPoint(board: Board, x: number, y: number, c: string): void {
  board[x] = board[x].slice(0, y) + c + board[x].slice(y + 1);
}

/**
 * The board after `color` plays (x, y): opponent chains left without
 * liberties are removed. undefined when the move is illegal - occupied,
 * off the board, suicide, or (with `history`) repeating an earlier board
 * (the game uses superko).
 */
export function play(board: Board, x: number, y: number, color: Stone, history: Board[] = []): Board | undefined {
  if (at(board, x, y) !== ".") return undefined;
  const next = [...board];
  setPoint(next, x, y, color);
  const enemy = opponentOf(color);
  for (const [nx, ny] of neighbors(next, x, y)) {
    if (next[nx][ny] !== enemy) continue;
    const chain = chainAt(next, nx, ny);
    if (chain.liberties.size === 0) for (const [sx, sy] of chain.stones) setPoint(next, sx, sy, ".");
  }
  if (chainAt(next, x, y).liberties.size === 0) return undefined;
  const flat = next.join("|");
  if (history.some((prior) => prior.join("|") === flat)) return undefined;
  return next;
}

export function countStones(board: Board, color: Stone): number {
  return board.reduce((sum, column) => sum + [...column].filter((c) => c === color).length, 0);
}

/**
 * Who owns each empty point: an empty region bordered only by one color
 * belongs to it (as the game scores territory); "?" when both or neither.
 * Keyed "x,y".
 */
export function territory(board: Board): Map<string, Stone | "?"> {
  const owner = new Map<string, Stone | "?">();
  for (let x = 0; x < board.length; x++) {
    for (let y = 0; y < board[x].length; y++) {
      if (board[x][y] !== "." || owner.has(key(x, y))) continue;
      const region = chainAt(board, x, y).stones;
      const borders = new Set<string>();
      for (const [rx, ry] of region) for (const [nx, ny] of neighbors(board, rx, ry)) if (board[nx][ny] !== ".") borders.add(board[nx][ny]);
      const who: Stone | "?" = borders.size === 1 ? ([...borders][0] as Stone) : "?";
      for (const [rx, ry] of region) owner.set(key(rx, ry), who);
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
  const dist = new Map<string, number>();
  const owner = new Map<string, Stone | "?">();
  let frontier: Point[] = [];
  for (let x = 0; x < board.length; x++) {
    for (let y = 0; y < board[x].length; y++) {
      const c = board[x][y];
      if (c !== "X" && c !== "O") continue;
      for (const [nx, ny] of neighbors(board, x, y)) {
        if (board[nx][ny] !== ".") continue;
        const k = key(nx, ny);
        if (!dist.has(k)) {
          dist.set(k, 1);
          owner.set(k, c);
          frontier.push([nx, ny]);
        } else if (dist.get(k) === 1 && owner.get(k) !== c) {
          owner.set(k, "?");
        }
      }
    }
  }
  for (let d = 2; frontier.length > 0; d++) {
    const next: Point[] = [];
    for (const [x, y] of frontier) {
      const from = owner.get(key(x, y)) as Stone | "?";
      for (const [nx, ny] of neighbors(board, x, y)) {
        if (board[nx][ny] !== ".") continue;
        const k = key(nx, ny);
        if (!dist.has(k)) {
          dist.set(k, d);
          owner.set(k, from);
          next.push([nx, ny]);
        } else if (dist.get(k) === d && owner.get(k) !== from) {
          owner.set(k, "?");
        }
      }
    }
    frontier = next;
  }
  return owner;
}

/** Area score for `color`: its stones plus the empty points it alone borders (komi not included). */
export function area(board: Board, color: Stone, owners: Map<string, Stone | "?"> = territory(board)): number {
  let points = countStones(board, color);
  for (const who of owners.values()) if (who === color) points++;
  return points;
}

export function emptyPoints(board: Board): Point[] {
  const out: Point[] = [];
  for (let x = 0; x < board.length; x++) for (let y = 0; y < board[x].length; y++) if (board[x][y] === ".") out.push([x, y]);
  return out;
}

export { key as pointKey };
