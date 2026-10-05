import { describe, it } from "vitest";
import { chooseMove, evaluateBoard, sensibleMoves } from "go/go_decisions";
import { Board, chainsOf, influence, play, territory } from "go/go_engine";
import { chooseMoveModeled, predictMove, seededRng } from "go/go_opponent_model";

// Engine timings on a mid-game 5x5 board, for engine work (the game runs
// every script on one thread, so these are time the game itself waits):
//   GO_PROFILE=1 npx vitest run src/go/go_profile
// 2026-10-05, after the numeric engine and per-move caching: play 3.5us,
// evaluateBoard ~20us, one-ply choice ~0.3ms, model ~9ms, rollout4 ~24ms
// on this board (from 26ms and 178ms before).
const node = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write: (s: string) => void } } }).process;
const report = (line: string): void => node?.stderr.write(line + "\n");
const mid: Board = ["X.O#.", ".XO..", "XXOO.", ".X.O.", "....."];
function time(label: string, n: number, f: () => unknown): void {
  const t = performance.now();
  for (let i = 0; i < n; i++) f();
  const us = ((performance.now() - t) / n) * 1000;
  report(`${label.padEnd(28)} ${us.toFixed(1)} us (${n}x)`);
}
describe.skipIf(!node?.env.GO_PROFILE)("engine profile", () => it("times each piece", async () => {
  const rng = seededRng(1);
  time("play", 2000, () => play(mid, 4, 4, "X"));
  time("chainsOf", 2000, () => chainsOf(mid, "X"));
  time("territory", 2000, () => territory(mid));
  time("influence", 2000, () => influence(mid));
  time("evaluateBoard", 500, () => evaluateBoard(mid, "X"));
  time("sensibleMoves", 200, () => sensibleMoves(mid, "X"));
  time("chooseMove (one-ply)", 50, () => chooseMove(mid, "X"));
  time("predictMove Daedalus", 20, () => predictMove("Daedalus", mid, "O", [], rng));
  time("predictMove Illuminati", 20, () => predictMove("Illuminati", mid, "O", [], rng));
  let t = performance.now();
  for (let i = 0; i < 3; i++) await chooseMoveModeled("Daedalus", mid, "X", []);
  report(`chooseMoveModeled model+follow ${((performance.now() - t) / 3).toFixed(1)} ms`);
  t = performance.now();
  for (let i = 0; i < 3; i++) await chooseMoveModeled("Daedalus", mid, "X", [], { followUp: false });
  report(`chooseMoveModeled model        ${((performance.now() - t) / 3).toFixed(1)} ms`);
  t = performance.now();
  await chooseMoveModeled("Illuminati", mid, "X", [], { rolloutPlies: 4, followUp: false });
  report(`chooseMoveModeled rollout4     ${(performance.now() - t).toFixed(1)} ms`);
}, 120000));
