import { NS } from "@ns";
import { loadJsonConfig } from "system/config";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import {
  chooseMove,
  DEFAULT_CONFIG,
  describeResults,
  GO_STATE_PATH,
  GO_STATUS_PATH,
  GoConfig,
  GoStateFile,
  GoStatusFile,
  pickOpponent,
  recordResult,
} from "go/go_decisions";

/**
 * Plays IPvGO (ns.go) without stopping: each win raises the opponent
 * faction's node power, which grows a lasting bonus (hacking money,
 * reputation, hacknet production, ...). Opponents come from the config's
 * priority list (go_decisions.ts's pickOpponent); moves from chooseMove,
 * which works from the board alone - the game's analysis calls cost 8-16
 * GB each, so this daemon only pays for getBoardState and makeMove.
 *
 * A game in progress when the daemon starts (a restart mid-game) is
 * finished, not reset: resetting a game with moves in it forfeits it.
 */
export const CONFIG_PATH = "/etc/go.txt";

type GoOpponentName = Parameters<NS["go"]["resetBoardState"]>[0];

const BETWEEN_GAMES_MS = 1_000;
const DISABLED_POLL_MS = 60_000;

function readState(ns: NS): GoStateFile {
  try {
    const state = JSON.parse(ns.read(GO_STATE_PATH) || "null") as GoStateFile | null;
    return state && typeof state.results === "object" ? state : { results: {} };
  } catch {
    return { results: {} };
  }
}

function writeStatus(ns: NS, config: GoConfig, state: GoStateFile, opponent: string | undefined): void {
  const stats = ns.go.analysis.getStats();
  const status: GoStatusFile = {
    opponent,
    boardSize: config.boardSize,
    bonuses: Object.fromEntries(
      Object.entries(stats).map(([name, s]) => [
        name,
        { wins: s.wins, losses: s.losses, winStreak: s.winStreak, bonusPercent: s.bonusPercent, bonusDescription: s.bonusDescription },
      ])
    ),
    recent: Object.fromEntries(Object.entries(state.results).map(([name, results]) => [name, describeResults(results)])),
    writtenAt: Date.now(),
  };
  ns.write(GO_STATUS_PATH, JSON.stringify(status), "w");
}

/** Plays the current game to the end as black; true if we won. */
async function playGame(ns: NS, log: Logger, boardSize: number): Promise<boolean> {
  const opponent = ns.go.getOpponent();
  const winsBefore = ns.go.analysis.getStats()[opponent]?.wins ?? 0;
  // A cap on our own moves - the game ends long before this; it only
  // guards against a position the engine misreads forever.
  const maxMoves = boardSize * boardSize * 3;
  for (let moves = 0; ns.go.getCurrentPlayer() !== "None"; moves++) {
    if (ns.go.getCurrentPlayer() === "White") {
      await ns.go.opponentNextTurn(false);
      continue;
    }
    const choice = moves < maxMoves ? chooseMove(ns.go.getBoardState(), "X", ns.go.getMoveHistory()) : { kind: "pass" as const };
    let result;
    try {
      result = choice.kind === "move" ? await ns.go.makeMove(choice.x, choice.y) : await ns.go.passTurn();
    } catch (e) {
      // The game refused the move (a rule the engine doesn't model): pass instead.
      await log.warn(`[Go] Move refused (${String(e)}); passing.`);
      result = await ns.go.passTurn();
    }
    if (result.type === "gameOver") break;
  }
  return (ns.go.analysis.getStats()[opponent]?.wins ?? 0) > winsBefore;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Go", LOG_LEVEL.INFO);
  await log.info("=== Go daemon online ===");

  // Opponents the game refused this run (not unlocked yet).
  const unavailable = new Set<string>();
  let state = readState(ns);

  while (true) {
    const config = loadJsonConfig<GoConfig>(ns, CONFIG_PATH, DEFAULT_CONFIG);
    if (!config.enabled) {
      writeStatus(ns, config, state, undefined);
      await ns.asleep(DISABLED_POLL_MS);
      continue;
    }

    if (ns.go.getCurrentPlayer() === "None") {
      const next = pickOpponent(config.opponents, state.results, unavailable, config.minGames, config.minWinRate);
      if (!next) {
        await log.warn(`[Go] No opponent available from ${config.opponents.join(", ")}; retrying later.`);
        unavailable.clear();
        await ns.asleep(DISABLED_POLL_MS);
        continue;
      }
      let board: string[] | undefined;
      try {
        board = ns.go.resetBoardState(next as GoOpponentName, config.boardSize);
      } catch {
        board = undefined;
      }
      if (!board) {
        await log.info(`[Go] ${next} isn't available yet; trying the next opponent.`);
        unavailable.add(next);
        await ns.asleep(BETWEEN_GAMES_MS);
        continue;
      }
    }

    const opponent = ns.go.getOpponent();
    const won = await playGame(ns, log, config.boardSize);
    state = { ...state, results: recordResult(state.results, opponent, won) };
    ns.write(GO_STATE_PATH, JSON.stringify(state), "w");
    writeStatus(ns, config, state, opponent);
    const bonus = ns.go.analysis.getStats()[opponent];
    await log.info(
      `[Go] ${won ? "Won" : "Lost"} against ${opponent} (${describeResults(state.results[opponent])} recently)` +
        (bonus ? `; bonus ${bonus.bonusPercent.toFixed(1)}% ${bonus.bonusDescription}, streak ${bonus.winStreak}.` : ".")
    );
    await ns.asleep(BETWEEN_GAMES_MS);
  }
}
