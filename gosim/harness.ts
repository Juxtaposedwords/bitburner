import { getNewBoardState, makeMove, passTurn } from "@bitburner/Go/boardState/boardState";
import { getMove } from "@bitburner/Go/boardAnalysis/goAI";
import { GoColor, GoOpponent } from "@bitburner/Go/Enums";
import type { BoardState } from "@bitburner/Go/Types";
import { Player } from "./stubs/player";
import { area, Board, Stone, territory } from "go/go_engine";
import { difficultyMultiplier, MoveChoice, OPPONENTS } from "go/go_decisions";

/**
 * One game of ours (black) against the game's own AI (white), with the
 * game's own board setup (offline nodes, handicap) and move rules. The
 * AI's waits are stubbed out, so a game takes milliseconds.
 */
export type Player_ = (board: Board, me: Stone, history: Board[]) => MoveChoice | Promise<MoveChoice>;

export function toBoard(state: BoardState): Board {
  return state.board.map((column) =>
    column.map((p) => (!p ? "#" : p.color === GoColor.black ? "X" : p.color === GoColor.white ? "O" : ".")).join("")
  );
}

export type GameOutcome = { won: boolean; score: number; theirs: number; moves: number; value: number; start: Board; final: Board; line: string[] };

// onAiMove: the board the AI faced, the history before it, and its move ("x,y" or "pass").
export type AiMoveHook = (board: Board, history: Board[], move: string) => void;

export async function playAgainstAI(us: Player_, opponent: string, seed: number, size = 5, onAiMove?: AiMoveHook): Promise<GameOutcome> {
  Player.totalPlaytime = seed;
  const state = getNewBoardState(size, opponent as GoOpponent, true);
  const history: Board[] = [];
  const start = toBoard(state);
  const line: string[] = [];
  let passes = 0;
  let moves = 0;
  let aiSeed = seed * 7919;
  for (; passes < 2 && moves < 200; moves++) {
    const before = toBoard(state);
    const choice = await us(before, "X", history);
    if (choice.kind === "move" && makeMove(state, choice.x, choice.y, GoColor.black)) {
      history.push(before);
      line.push(`X${choice.x}${choice.y}`);
      passes = 0;
    } else {
      line.push("Xpass");
      passTurn(state, GoColor.black, false);
      passes++;
    }
    if (passes >= 2) break;
    const reply = await getMove(state, GoColor.white, opponent as GoOpponent, false, (aiSeed = (aiSeed * 16807) % 2147483647) / 2147483647 + 1e-9);
    const prior = toBoard(state);
    onAiMove?.(prior, [...history], reply.type === "move" ? `${reply.x},${reply.y}` : "pass");
    if (reply.type === "move" && makeMove(state, reply.x as number, reply.y as number, GoColor.white)) {
      history.push(prior);
      line.push(`O${reply.x}${reply.y}`);
      passes = 0;
    } else {
      line.push("Opass");
      passTurn(state, GoColor.white, false);
      passes++;
    }
  }
  const board = toBoard(state);
  const owners = territory(board);
  const score = area(board, "X", owners);
  const theirs = area(board, "O", owners) + OPPONENTS[opponent].komi;
  const won = score > theirs;
  return { won, score, theirs, moves, value: score * difficultyMultiplier(OPPONENTS[opponent].komi, size) * (won ? 1.25 : 0.5), start, final: board, line };
}
