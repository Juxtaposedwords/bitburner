import { getNewBoardStateFromSimpleBoard } from "/home/maloy/Development/vendor/bitburner-src/src/Go/boardState/boardState";
import { getMove } from "/home/maloy/Development/vendor/bitburner-src/src/Go/boardAnalysis/goAI";
import { GoColor, GoOpponent } from "/home/maloy/Development/vendor/bitburner-src/src/Go/Enums";
import { Board, play, Stone } from "go/go_engine";
import { DEFAULT_WEIGHTS, evaluateBoard, EvalWeights, MoveChoice, sensibleMoves } from "go/go_decisions";

/**
 * Opponent modeling: each of our sensible moves is answered by the real
 * AI under `samples` of its random draws; the move with the best average
 * position afterwards (evaluateBoard) is played. With `followUp`, each
 * position is first improved by our best one-ply answer.
 */
export function modelPlayer(opponent: string, samples = 6, w: EvalWeights = DEFAULT_WEIGHTS, followUp = false) {
  const draws = Array.from({ length: samples }, (_, i) => (i + 0.5) / samples);
  return async (board: Board, me: Stone, history: Board[]): Promise<MoveChoice> => {
    let best: MoveChoice = { kind: "pass" };
    let bestValue = -Infinity;
    for (const m of sensibleMoves(board, me, history)) {
      let total = 0;
      for (const r of draws) {
        const state = getNewBoardStateFromSimpleBoard(m.next, board, GoOpponent.Netburners, GoColor.black);
        const reply = await getMove(state, GoColor.white, opponent as GoOpponent, false, r);
        const after = reply.type === "move" ? (play(m.next, reply.x as number, reply.y as number, "O") ?? m.next) : m.next;
        let value = evaluateBoard(after, me, w);
        if (followUp) for (const f of sensibleMoves(after, me, [...history, board, m.next])) value = Math.max(value, evaluateBoard(f.next, me, w));
        total += value;
      }
      if (total / samples > bestValue) {
        bestValue = total / samples;
        best = { kind: "move", x: m.x, y: m.y, score: bestValue };
      }
    }
    return best;
  };
}
