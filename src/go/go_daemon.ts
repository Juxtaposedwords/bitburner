import { NS } from "@ns";
import { loadJsonConfig } from "system/config";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import {
  chooseMove,
  chooseMoveMinimax,
  DEFAULT_CONFIG,
  difficultyMultiplier,
  describeResults,
  GO_STATE_PATH,
  GO_STATUS_PATH,
  GoConfig,
  GoStateFile,
  GoStatusFile,
  MoveChoice,
  nodePowerGained,
  pickOpponentByValue,
  recordGame,
  recordResult,
} from "go/go_decisions";
import { readPhasePolicy } from "system/phase";
import { pickStrategy, recordStrategy, Strategy, strategiesFor, strategyValue } from "go/go_strategy";

/**
 * Plays IPvGO (ns.go) without stopping: each win raises the opponent
 * faction's node power, which grows a bonus (hacking money, reputation,
 * hacknet production, ...) until the next install zeroes it. The opponent
 * is the one adding the most phase-weighted bonus per second
 * (pickOpponentByValue, weights from system/phase.ts's goWeights); moves
 * come from the board alone (chooseMoveMinimax / chooseMove) - the game's
 * analysis calls cost 8-16 GB each, so this daemon only pays for
 * getBoardState and makeMove.
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
    return state && typeof state.results === "object"
      ? { results: state.results, records: state.records ?? {}, strategies: state.strategies ?? {} }
      : { results: {}, records: {}, strategies: {} };
  } catch {
    return { results: {}, records: {}, strategies: {} };
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
    strategies: Object.fromEntries(
      Object.entries(state.strategies).map(([name, byStrategy]) => [
        name,
        Object.fromEntries(Object.entries(byStrategy).map(([s, [games, total]]) => [s, `${(total / games).toFixed(1)} over ${games}`])),
      ])
    ),
    writtenAt: Date.now(),
  };
  ns.write(GO_STATUS_PATH, JSON.stringify(status), "w");
}

type GameResult = {
  won: boolean;
  blackScore: number;
  whiteScore: number;
  power: number;
  value: number;
  seconds: number;
};

/** Our move: the strategy's search on small boards, the one-ply engine otherwise. */
function nextMove(ns: NS, config: GoConfig, strategy: Strategy): MoveChoice {
  const board = ns.go.getBoardState();
  const history = ns.go.getMoveHistory();
  return board.length <= config.searchMaxBoardSize
    ? chooseMoveMinimax(board, "X", history, Math.min(strategy.depth, config.searchDepth), strategy.weights)
    : chooseMove(board, "X", history);
}

/** Plays the current game to the end as black. */
async function playGame(ns: NS, log: Logger, config: GoConfig, strategy: Strategy): Promise<GameResult> {
  const started = Date.now();
  const opponent = ns.go.getOpponent();
  const before = ns.go.analysis.getStats()[opponent];
  const winsBefore = before?.wins ?? 0;
  // A cap on our own moves - the game ends long before this; it only
  // guards against a position the engine misreads forever.
  const maxMoves = config.boardSize * config.boardSize * 3;
  for (let moves = 0; ns.go.getCurrentPlayer() !== "None"; moves++) {
    if (ns.go.getCurrentPlayer() === "White") {
      await ns.go.opponentNextTurn(false);
      continue;
    }
    const choice: MoveChoice = moves < maxMoves ? nextMove(ns, config, strategy) : { kind: "pass" };
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
  const after = ns.go.analysis.getStats()[opponent];
  const { blackScore, whiteScore, komi } = ns.go.getGameState();
  const size = ns.go.getBoardState().length;
  const won = (after?.wins ?? 0) > winsBefore;
  return {
    won,
    value: strategyValue(blackScore, difficultyMultiplier(komi, size), won),
    blackScore,
    whiteScore,
    power: nodePowerGained(blackScore, komi, size, after?.winStreak ?? 0, before?.winStreak ?? 0),
    seconds: (Date.now() - started) / 1000,
  };
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
      const weights = { ...readPhasePolicy(ns).goWeights, ...config.opponentWeights };
      const gamesPlayed = Object.fromEntries(Object.entries(ns.go.analysis.getStats()).map(([name, s]) => [name, s.wins + s.losses]));
      const next = pickOpponentByValue(weights, state.records, gamesPlayed, unavailable, config.boardSize);
      if (!next) {
        await log.warn(`[Go] No weighted opponent available (${JSON.stringify(weights)}); retrying later.`);
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
    const strategy = pickStrategy(strategiesFor(opponent), state.strategies[opponent]);
    const game = await playGame(ns, log, config, strategy);
    const won = game.won;
    const played = ns.go.analysis.getStats()[opponent];
    state = {
      results: recordResult(state.results, opponent, won),
      records: recordGame(state.records, opponent, game.power, game.seconds, (played?.wins ?? 0) + (played?.losses ?? 0)),
      strategies: recordStrategy(state.strategies, opponent, strategy.name, game.value),
    };
    ns.write(GO_STATE_PATH, JSON.stringify(state), "w");
    writeStatus(ns, config, state, opponent);
    const bonus = ns.go.analysis.getStats()[opponent];
    await log.info(
      `[Go] ${won ? "Won" : "Lost"} against ${opponent} (${strategy.name}) ${game.blackScore}-${game.whiteScore} on ${ns.go.getBoardState().length}x` +
        ` in ${game.seconds.toFixed(0)}s, +${game.power.toFixed(1)} power (${describeResults(state.results[opponent])} recently)` +
        (bonus ? `; bonus ${bonus.bonusPercent.toFixed(1)}% ${bonus.bonusDescription}, streak ${bonus.winStreak}.` : ".")
    );
    await ns.asleep(BETWEEN_GAMES_MS);
  }
}
