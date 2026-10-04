import { Board, neighbors, opponentOf, play, Point, pointKey, Stone } from "go/go_engine";
import { DEFAULT_WEIGHTS, evaluateBoard, EvalWeights, MoveChoice, sensibleMoves } from "go/go_decisions";

/**
 * A model of how the game's IPvGO opponents choose moves, so our search can
 * answer the replies they'll actually make (go_decisions.ts's
 * chooseMoveModeled) instead of assuming they play like us.
 *
 * Written from the behavior of the game's AI (as studied in its source,
 * Go/boardAnalysis/goAI.ts): each faction walks a priority list - capture,
 * save a chain in atari, make an eye, take a liberty, block an eye, take a
 * corner, play a known shape, jump, expand - with random thresholds of its
 * own, and the "smart" ones never play a stone that can be captured at
 * once. None of the game's code is copied; this is our implementation on
 * our own board rules. The 3x3 shapes are the standard set from Michi
 * (github.com/pasky/michi, MIT), which the game also uses.
 *
 * Fidelity against the real AI is measured offline in gosim/ (how often
 * the model's most likely move is the one the AI plays).
 */
export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

type Region = { id: number; color: string; points: Point[]; liberties: Point[]; neighborIds: number[] };

/** Every chain on the board - stone chains and empty regions - with liberties (stones) and bordering chains. */
class Chains {
  readonly id: number[][];
  readonly regions: Region[] = [];
  constructor(readonly board: Board) {
    this.id = board.map((col) => Array<number>(col.length).fill(-1));
    for (let x = 0; x < board.length; x++) {
      for (let y = 0; y < board[x].length; y++) {
        if (board[x][y] === "#" || this.id[x][y] !== -1) continue;
        const color = board[x][y];
        const region: Region = { id: this.regions.length, color, points: [], liberties: [], neighborIds: [] };
        const stack: Point[] = [[x, y]];
        this.id[x][y] = region.id;
        while (stack.length > 0) {
          const [cx, cy] = stack.pop() as Point;
          region.points.push([cx, cy]);
          for (const [nx, ny] of neighbors(board, cx, cy)) {
            if (board[nx][ny] === color && this.id[nx][ny] === -1) {
              this.id[nx][ny] = region.id;
              stack.push([nx, ny]);
            }
          }
        }
        this.regions.push(region);
      }
    }
    for (const region of this.regions) {
      const libs = new Set<string>();
      const near = new Set<number>();
      for (const [px, py] of region.points) {
        for (const [nx, ny] of neighbors(board, px, py)) {
          const other = this.id[nx][ny];
          if (other !== region.id) near.add(other);
          if (region.color !== "." && board[nx][ny] === "." && !libs.has(pointKey(nx, ny))) {
            libs.add(pointKey(nx, ny));
            region.liberties.push([nx, ny]);
          }
        }
      }
      region.neighborIds = [...near];
    }
  }
  at(x: number, y: number): Region | undefined {
    const i = this.id[x]?.[y];
    return i === undefined || i < 0 ? undefined : this.regions[i];
  }
  ofColor(color: string): Region[] {
    return this.regions.filter((r) => r.color === color);
  }
}

const has = (points: Point[], x: number, y: number): boolean => points.some(([px, py]) => px === x && py === y);
const liveNodes = (board: Board): number => board.join("").replace(/#/g, "").length;

/** The liberties a stone at (x, y) would have before any capture: its empty neighbors plus those of the chains it joins. */
function effectiveLiberties(c: Chains, x: number, y: number, me: Stone): number {
  const libs = new Set<string>();
  for (const [nx, ny] of neighbors(c.board, x, y)) {
    const v = c.board[nx][ny];
    if (v === ".") libs.add(pointKey(nx, ny));
    else if (v === me) for (const [lx, ly] of c.at(nx, ny)?.liberties ?? []) libs.add(pointKey(lx, ly));
  }
  libs.delete(pointKey(x, y));
  return libs.size;
}

/** The chain of `color` next to (x, y) with the fewest liberties. */
function weakestNeighbor(c: Chains, x: number, y: number, color: string): Region | undefined {
  let weakest: Region | undefined;
  for (const [nx, ny] of neighbors(c.board, x, y)) {
    if (c.board[nx][ny] !== color) continue;
    const chain = c.at(nx, ny) as Region;
    if (!weakest || chain.liberties.length < weakest.liberties.length) weakest = chain;
  }
  return weakest;
}

/** Empty regions (up to min(40% of the board, 11) points) bordered only by `color` stones. */
function potentialEyes(c: Chains, color: string): Region[] {
  const maxSize = Math.min(liveNodes(c.board) * 0.4, 11);
  return c.ofColor(".").filter((r) => {
    if (r.points.length > maxSize) return false;
    const around = r.neighborIds.map((i) => c.regions[i].color);
    return around.length > 0 && around.every((col) => col === color);
  });
}

/** Whether `chain` alone encloses `eye`: with the other bordering chains lifted, the space still touches only it. */
function enclosesAlone(c: Chains, eye: Region, chain: Region): boolean {
  const spread = (points: Point[]): { n: number; e: number; s: number; w: number } => ({
    n: Math.max(...points.map(([, y]) => y)),
    e: Math.max(...points.map(([x]) => x)),
    s: Math.min(...points.map(([, y]) => y)),
    w: Math.min(...points.map(([x]) => x)),
  });
  const edge = c.board.length - 1;
  const a = spread(eye.points);
  const b = spread(chain.points);
  if (!(b.n > a.n || (a.n === edge && b.n === edge))) return false;
  if (!(b.e > a.e || (a.e === edge && b.e === edge))) return false;
  if (!(b.s < a.s || (a.s === 0 && b.s === 0))) return false;
  if (!(b.w < a.w || (a.w === 0 && b.w === 0))) return false;
  const lifted = c.board.map((col) => col.split(""));
  for (const i of eye.neighborIds) if (i !== chain.id) for (const [px, py] of c.regions[i].points) lifted[px][py] = ".";
  const after = new Chains(lifted.map((col) => col.join("")));
  const [ex, ey] = eye.points[0];
  const space = after.at(ex, ey) as Region;
  const bordering = new Set<number>();
  for (const [px, py] of space.points) {
    for (const [nx, ny] of neighbors(c.board, px, py)) {
      const original = c.at(nx, ny);
      if (original && !has(space.points, nx, ny)) bordering.add(original.id);
    }
  }
  return bordering.size === 1;
}

/** Eyes per stone chain of `color` (chain id -> its eye regions). */
function eyesByChain(c: Chains, color: string): Map<number, Region[]> {
  const eyes = new Map<number, Region[]>();
  for (const eye of potentialEyes(c, color)) {
    const owners = eye.neighborIds.length === 1 ? [c.regions[eye.neighborIds[0]]] : eye.neighborIds.map((i) => c.regions[i]).filter((chain) => enclosesAlone(c, eye, chain));
    for (const owner of owners) eyes.set(owner.id, [...(eyes.get(owner.id) ?? []), eye]);
  }
  return eyes;
}

type Move = { x: number; y: number; oldLibs: number; newLibs: number };
type EyeMove = { x: number; y: number; createsLife: boolean };

/** Everything one position offers a faction, computed lazily (as the game does). */
class Options {
  readonly c: Chains;
  readonly enemy: Stone;
  readonly available: Point[];
  readonly contested: Point[];
  readonly endGame: boolean;
  private cache = new Map<string, unknown>();

  constructor(
    readonly board: Board,
    readonly me: Stone,
    readonly history: Board[],
    readonly rng: number,
    readonly smart: boolean,
    opponentPassed: boolean
  ) {
    this.c = new Chains(board);
    this.enemy = opponentOf(me);
    this.available = this.disputedTerritory();
    this.contested = this.contestedPoints(this.available, 99);
    this.endGame = this.contested.length === 0 && opponentPassed;
  }

  private memo<T>(key: string, f: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, f());
    return this.cache.get(key) as T;
  }

  private isAvailable(x: number, y: number): boolean {
    return has(this.available, x, y);
  }

  /** Legal moves, less our living groups' eyes (when smart) and the opponent's enclosed space unless it can be attacked. */
  private disputedTerritory(): Point[] {
    let valid: Point[] = [];
    for (let x = 0; x < this.board.length; x++) for (let y = 0; y < this.board[x].length; y++) if (this.board[x][y] === "." && play(this.board, x, y, this.me, this.history)) valid.push([x, y]);
    if (this.smart) {
      const living = [...eyesByChain(this.c, this.me).values()].filter((e) => e.length >= 2).flat();
      valid = valid.filter(([x, y]) => !living.some((eye) => has(eye.points, x, y)));
    }
    const spaces = potentialEyes(this.c, this.enemy);
    const inside = spaces.flatMap((s) => s.points);
    const attackable: Point[] = [];
    for (const space of spaces) {
      for (const i of space.neighborIds) {
        const chain = this.c.regions[i];
        if (chain.liberties.length > 4) continue;
        if (!chain.neighborIds.some((j) => this.c.regions[j].color === this.me)) continue;
        const inSpace = chain.liberties.filter(([lx, ly]) => has(space.points, lx, ly));
        if (inSpace.length !== chain.liberties.length) continue;
        attackable.push(...inSpace);
      }
    }
    return valid.filter(([x, y]) => !has(inside, x, y) || has(attackable, x, y));
  }

  /** Available points in empty regions (of at most `maxSize`) that border both colors. */
  private contestedPoints(available: Point[], maxSize: number): Point[] {
    return available.filter(([x, y]) => {
      const region = this.c.at(x, y) as Region;
      if (region.points.length > maxSize) return false;
      const colors = region.neighborIds.map((i) => this.c.regions[i].color);
      return colors.includes("X") && colors.includes("O");
    });
  }

  expansionMoves(): Point[] {
    return this.memo("expansionMoves", () => {
      const open = this.available.filter(([x, y]) => {
        const n = neighbors(this.board, x, y);
        return n.length === 4 && n.every(([nx, ny]) => this.board[nx][ny] === ".");
      });
      return open.length > 0 ? open : this.contestedPoints(this.available, 1);
    });
  }

  expansion(): Point | undefined {
    const moves = this.expansionMoves();
    return moves[Math.floor(this.rng * moves.length)];
  }

  jump(): Point | undefined {
    const moves = this.expansionMoves().filter(([x, y]) =>
      [
        [x, y + 2],
        [x + 2, y],
        [x, y - 2],
        [x - 2, y],
      ].some(([jx, jy]) => this.board[jx]?.[jy] === this.me)
    );
    return moves[Math.floor(this.rng * moves.length)];
  }

  private growthMoves(): Move[] {
    return this.memo("growthMoves", () => {
      const out: Move[] = [];
      for (const chain of this.c.ofColor(this.me)) {
        for (const [x, y] of chain.liberties) {
          if (!this.isAvailable(x, y)) continue;
          const newLibs = effectiveLiberties(this.c, x, y, this.me);
          const oldLibs = weakestNeighbor(this.c, x, y, this.me)?.liberties.length ?? 99;
          if (newLibs > 1 && newLibs >= oldLibs) out.push({ x, y, oldLibs, newLibs });
        }
      }
      return out;
    });
  }

  growth(): Move | undefined {
    if (this.endGame) return undefined;
    const moves = this.growthMoves();
    const best = Math.max(...moves.map((m) => m.newLibs - m.oldLibs));
    const top = moves.filter((m) => m.newLibs - m.oldLibs === best);
    return top[Math.floor(this.rng * top.length)];
  }

  defend(): Move | undefined {
    return this.memo("defend", () => {
      const rising = this.growthMoves().filter((m) => m.oldLibs <= 1 && m.newLibs > m.oldLibs);
      const best = Math.max(...rising.map((m) => m.newLibs - m.oldLibs));
      if (!(best >= 1)) return undefined;
      const top = rising.filter((m) => m.newLibs - m.oldLibs === best);
      return top[Math.floor(Math.random() * top.length)];
    });
  }

  defendCapture(): Move | undefined {
    const d = this.defend();
    return d && d.oldLibs === 1 && d.newLibs > 1 ? d : undefined;
  }

  surround(): Move | undefined {
    return this.memo("surround", () => {
      const captures: Move[] = [];
      const ataris: Move[] = [];
      const surrounds: Move[] = [];
      for (const chain of this.c.ofColor(this.enemy)) {
        for (const [x, y] of chain.liberties) {
          if (!this.isAvailable(x, y)) continue;
          const newLibs = effectiveLiberties(this.c, x, y, this.me);
          const weakest = weakestNeighbor(this.c, x, y, this.enemy);
          const enemyLibs = weakest?.liberties.length ?? 99;
          const weakestSize = weakest?.points.length ?? 99;
          const libertyGroups = new Set((weakest?.liberties ?? []).map(([lx, ly]) => this.c.at(lx, ly)?.id)).size;
          if (newLibs <= 2 && enemyLibs > 2) continue;
          const move = { x, y, oldLibs: enemyLibs, newLibs: enemyLibs - 1 };
          if (enemyLibs <= 1) captures.push(move);
          else if (enemyLibs === 2 && (newLibs >= 2 || (libertyGroups === 1 && weakestSize > 3) || !this.smart)) ataris.push(move);
          else if (newLibs >= 2) surrounds.push(move);
        }
      }
      return [...captures, ...ataris, ...surrounds][0];
    });
  }

  capture(): Move | undefined {
    const s = this.surround();
    return s && s.newLibs === 0 ? s : undefined;
  }

  /** Moves that give `color` an eye, those making a group alive (two eyes) first. */
  eyeCreationMoves(color: Stone, maxLiberties = 99): EyeMove[] {
    const eyes = eyesByChain(this.c, color);
    const living = [...eyes.entries()].filter(([, e]) => e.length >= 2).map(([id]) => id);
    const eyeCount = [...eyes.values()].filter((e) => e.length > 0).length;
    const candidates: Point[] = [];
    for (const chain of this.c.ofColor(color)) {
      if (chain.points.length <= 1 || chain.liberties.length > maxLiberties || living.includes(chain.id)) continue;
      for (const [x, y] of chain.liberties) {
        if (!this.isAvailable(x, y)) continue;
        const around = [
          [x, y + 1],
          [x + 1, y],
          [x, y - 1],
          [x - 1, y],
        ].map(([nx, ny]) => this.board[nx]?.[ny]);
        if (around.filter((v) => v === undefined || v === "#" || v === color).length >= 2 && around.some((v) => v === ".")) candidates.push([x, y]);
      }
    }
    const out: EyeMove[] = [];
    for (const [x, y] of candidates) {
      const after = play(this.board, x, y, color);
      if (!after) continue;
      const newEyes = [...eyesByChain(new Chains(after), color).values()];
      const newLiving = newEyes.filter((e) => e.length >= 2).length;
      const newCount = newEyes.filter((e) => e.length > 0).length;
      if (newLiving > living.length || (newCount > eyeCount && newLiving === living.length)) out.push({ x, y, createsLife: newLiving > living.length });
    }
    return out.sort((a, b) => +b.createsLife - +a.createsLife);
  }

  eyeMove(): EyeMove | undefined {
    if (this.endGame) return undefined;
    return this.memo("eyeMove", () => this.eyeCreationMoves(this.me)[0]);
  }

  eyeBlock(): EyeMove | undefined {
    if (this.endGame) return undefined;
    return this.memo("eyeBlock", () => {
      const theirs = this.eyeCreationMoves(this.enemy, 5);
      const life = theirs.filter((m) => m.createsLife);
      const one = theirs.filter((m) => !m.createsLife);
      if (life.length === 1) return life[0];
      if (life.length === 0 && one.length === 1) return one[0];
      return undefined;
    });
  }

  /** The point two in from a corner (on 5x5, the center) while that corner's 3x3 is empty. */
  corner(): Point | undefined {
    const edge = this.board.length - 1;
    const max = edge - 2;
    const open = (x1: number, y1: number, x2: number, y2: number): boolean => {
      let live = 0;
      let stones = 0;
      for (let x = x1; x <= x2; x++)
        for (let y = y1; y <= y2; y++) {
          const v = this.board[x]?.[y];
          if (v === undefined || v === "#") continue;
          live++;
          if (v !== ".") stones++;
        }
      return live >= 7 && stones === 0;
    };
    if (open(max, max, edge, edge)) return [max, max];
    if (open(0, max, 2, edge)) return [2, max];
    if (open(0, 0, 2, 2)) return [2, 2];
    if (open(max, 0, edge, 2)) return [max, 2];
    return undefined;
  }

  pattern(): Point | undefined {
    if (this.endGame) return undefined;
    return this.memo("pattern", () => {
      const moves: Point[] = [];
      for (let x = 0; x < this.board.length; x++) {
        for (let y = 0; y < this.board[x].length; y++) {
          if (!matchesAnyShape(this.board, x, y, this.me)) continue;
          if (!this.isAvailable(x, y)) continue;
          if (this.smart && effectiveLiberties(this.c, x, y, this.me) <= 1) continue;
          moves.push([x, y]);
        }
      }
      return moves[Math.floor(this.rng * moves.length)];
    });
  }

  random(): Point | undefined {
    return this.contested.length > 0 ? this.available[Math.floor(this.rng * this.available.length)] : undefined;
  }
}

// Michi's 3x3 shapes, from the moving side's view: X ours, O theirs, x not
// theirs, o not ours, . empty, " " a dead node, ? anything. Read with the
// first string as column x-1 (y-1..y+1), the middle as column x.
const SHAPES = [
  ["XOX", "...", "???"],
  ["XO.", "...", "?.?"],
  ["XO?", "X..", "o.?"],
  [".O.", "X..", "..."],
  ["XO?", "O.x", "?x?"],
  ["XO?", "O.X", "???"],
  ["?X?", "O.O", "xxx"],
  ["OX?", "x.O", "???"],
  ["X.?", "O.?", "   "],
  ["OX?", "X.O", "   "],
  ["?X?", "o.O", "   "],
  ["?XO", "o.o", "   "],
  ["?OX", "X.O", "   "],
];

const rotate = (s: string[]): string[] => [0, 1, 2].map((i) => `${s[2][i]}${s[1][i]}${s[0][i]}`);
const mirror = (s: string[]): string[] => [s[2], s[1], s[0]];
const ALL_SHAPES: string[][] = (() => {
  const rotations = [...SHAPES, ...SHAPES.map(rotate), ...SHAPES.map(rotate).map(rotate), ...SHAPES.map(rotate).map(rotate).map(rotate)];
  return [...rotations, ...rotations.map(mirror)];
})();

/**
 * Whether the 3x3 around (x, y) fits a shape for `me`. Off-board points
 * only satisfy "?" and the "not" codes ("x", "o"); dead nodes also satisfy
 * " " - the game's own matcher treats the two differently.
 */
function matchesAnyShape(board: Board, x: number, y: number, me: Stone): boolean {
  const enemy = opponentOf(me);
  const cell = (dx: number, dy: number): string | undefined => board[x + dx]?.[y + dy];
  return ALL_SHAPES.some((shape) => {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const want = shape[i][j];
        const v = cell(i - 1, j - 1);
        const ok =
          want === "?" ||
          (want === "X" && v === me) ||
          (want === "O" && v === enemy) ||
          (want === "x" && v !== enemy) ||
          (want === "o" && v !== me) ||
          (want === "." && v === ".") ||
          (want === " " && v === "#");
        if (!ok) return false;
      }
    }
    return true;
  });
}

const pt = (p: { x: number; y: number } | Point | undefined): Point | undefined => (p === undefined ? undefined : Array.isArray(p) ? p : [p.x, p.y]);

function illuminatiPriority(o: Options, rng: number): Point | undefined {
  const capture = o.capture();
  if (capture) return pt(capture);
  const defend = o.defendCapture();
  if (defend) return pt(defend);
  const eye = o.eyeMove();
  if (eye) return pt(eye);
  const surround = o.surround();
  if (surround && surround.newLibs <= 1) return pt(surround);
  const block = o.eyeBlock();
  if (block) return pt(block);
  const corner = o.corner();
  if (corner) return corner;
  const hasMoves = [o.eyeMove(), o.eyeBlock(), o.growth(), o.defend(), surround].some(Boolean);
  const pattern = o.pattern();
  if (pattern && (rng > 0.25 || !hasMoves)) return pattern;
  const jump = rng > 0.4 ? o.jump() : undefined;
  if (jump) return jump;
  if (rng < 0.6 && surround && surround.newLibs <= 2) return pt(surround);
  return undefined;
}

const PRIORITIES: Record<string, (o: Options, rng: number) => Point | undefined> = {
  Netburners: (o, rng) => {
    if (rng < 0.2) return illuminatiPriority(o, rng);
    if (rng < 0.4 && o.expansion()) return o.expansion();
    if (rng < 0.6 && o.growth()) return pt(o.growth());
    if (rng < 0.75) return o.random();
    return undefined;
  },
  "Slum Snakes": (o, rng) => {
    const defend = o.defendCapture();
    if (defend) return pt(defend);
    if (rng < 0.2) return illuminatiPriority(o, rng);
    if (rng < 0.6 && o.growth()) return pt(o.growth());
    if (rng < 0.65) return o.random();
    return undefined;
  },
  "The Black Hand": (o, rng) => {
    const capture = o.capture();
    if (capture) return pt(capture);
    const surround = o.surround();
    if (surround && surround.newLibs <= 1) return pt(surround);
    const defend = o.defendCapture();
    if (defend) return pt(defend);
    if (surround && surround.newLibs <= 2) return pt(surround);
    if (rng < 0.3) return illuminatiPriority(o, rng);
    if (rng < 0.75 && surround) return pt(surround);
    if (rng < 0.8) return o.random();
    return undefined;
  },
  Tetrads: (o, rng) => {
    const capture = o.capture();
    if (capture) return pt(capture);
    const defend = o.defendCapture();
    if (defend) return pt(defend);
    const pattern = o.pattern();
    if (pattern) return pattern;
    const surround = o.surround();
    if (surround && surround.newLibs <= 1) return pt(surround);
    if (rng < 0.4) return illuminatiPriority(o, rng);
    return undefined;
  },
  Daedalus: (o, rng) => (rng < 0.9 ? illuminatiPriority(o, rng) : undefined),
  Illuminati: illuminatiPriority,
};

const SMART_CHANCE: Record<string, number> = { Netburners: 0, "Slum Snakes": 0.3, "The Black Hand": 0.8 };

/**
 * One sampled reply from `opponent` playing `me`: its priority move if one
 * applies, else a random pick among the reasonable kinds, else a pass.
 * `opponentPassed`: the other side passed last turn (the AI then stops
 * extending the game when nothing is contested).
 */
export function predictMove(opponent: string, board: Board, me: Stone, history: Board[], rng: Rng, opponentPassed = false): MoveChoice {
  const smart = rng() < (SMART_CHANCE[opponent] ?? 1);
  const options = new Options(board, me, history, rng(), smart, opponentPassed);
  const priority = (PRIORITIES[opponent] ?? illuminatiPriority)(options, rng());
  const legal = (p: Point | undefined): p is Point => !!p && !!play(board, p[0], p[1], me, history);
  if (legal(priority)) return { kind: "move", x: priority[0], y: priority[1], score: 0 };
  const reasonable = [pt(options.growth()), pt(options.surround()), pt(options.defend()), options.expansion(), options.pattern(), pt(options.eyeMove()), pt(options.eyeBlock())].filter(legal);
  const chosen = reasonable[Math.floor(rng() * reasonable.length)];
  return chosen ? { kind: "move", x: chosen[0], y: chosen[1], score: 0 } : { kind: "pass" };
}

/**
 * Our move by modeling the opponent: each sensible move is answered by
 * `samples` predicted replies (predictMove over evenly spread random
 * draws), each followed by our best one-ply answer, and scored by
 * evaluateBoard; the best average wins. Against the game's real
 * Illuminati this roughly doubled node power per game over the plain
 * search (gosim/). `yieldEvery` lets a caller in the game breathe between
 * candidates - each is a few milliseconds of work.
 */
export async function chooseMoveModeled(
  opponent: string,
  board: Board,
  me: Stone,
  history: Board[],
  opts: { samples?: number; weights?: EvalWeights; followUp?: boolean; opponentPassed?: boolean; yieldEvery?: () => Promise<void> } = {}
): Promise<MoveChoice> {
  const samples = opts.samples ?? 6;
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  let best: MoveChoice = { kind: "pass" };
  let bestValue = -Infinity;
  for (const m of sensibleMoves(board, me, history)) {
    const after = [...history, board];
    let total = 0;
    for (let i = 0; i < samples; i++) {
      // Evenly spread draws: the same sample set for every candidate, so they're compared on equal terms.
      const draws = seededRng(1000 + i);
      const reply = predictMove(opponent, m.next, opponentOf(me), after, draws);
      const replied = reply.kind === "move" ? (play(m.next, reply.x, reply.y, opponentOf(me), after) ?? m.next) : m.next;
      let value = evaluateBoard(replied, me, w);
      if (opts.followUp ?? true) for (const f of sensibleMoves(replied, me, [...after, m.next])) value = Math.max(value, evaluateBoard(f.next, me, w));
      total += value;
    }
    if (total / samples > bestValue) {
      bestValue = total / samples;
      best = { kind: "move", x: m.x, y: m.y, score: bestValue };
    }
    if (opts.yieldEvery) await opts.yieldEvery();
  }
  return best;
}
