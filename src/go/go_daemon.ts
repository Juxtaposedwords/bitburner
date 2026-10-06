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
  GO_HISTORY_PATH,
  GO_STATUS_PATH,
  appendHistory,
  GoConfig,
  GoStateFile,
  GoStatusFile,
  MoveChoice,
  nodePowerGained,
  bestOpponent,
  bonusPctPerHour,
  recordGame,
  recordResult,
} from "go/go_decisions";
import { readPhasePolicy } from "system/phase";
import { Board, play } from "go/go_engine";
import { deadlineIn } from "system/deadline";
import { MAX_REDEALS, pickStrategy, recordStrategy, shouldRedeal, Strategy, strategiesFor, strategyValue } from "go/go_strategy";
import { chooseMoveModeled } from "go/go_opponent_model";

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
// Pause when the opponent still hasn't moved after its turn promise settled.
const WHITE_WAIT_MS = 200;
const DISABLED_POLL_MS = 60_000;

function readState(ns: NS): GoStateFile {
  try {
    const state = JSON.parse(ns.read(GO_STATE_PATH) || "null") as GoStateFile | null;
    return state && typeof state.results === "object"
      ? { results: state.results, records: state.records ?? {}, strategies: state.strategies ?? {}, redealCostly: state.redealCostly }
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
  start: string[];
  resumed: boolean;
  line: string[];
  won: boolean;
  blackScore: number;
  whiteScore: number;
  power: number;
  value: number;
  seconds: number;
};

/**
 * Our move: on small boards the strategy's - the opponent model (pausing
 * between candidates so the game's UI keeps up) or the plain search; the
 * one-ply engine on bigger boards.
 */
async function nextMove(
  ns: NS,
  config: GoConfig,
  strategy: Strategy,
  opponent: string,
  opponentPassed: boolean,
  board: Board,
  history: Board[]
): Promise<MoveChoice> {
  if (board.length > config.searchMaxBoardSize) return chooseMove(board, "X", history);
  if (strategy.kind === "model") {
    return chooseMoveModeled(opponent, board, "X", history, {
      weights: strategy.weights,
      followUp: strategy.followUp ?? false,
      rolloutPlies: strategy.rolloutPlies,
      opponentPassed,
      deadline: deadlineIn(config.moveBudgetMs),
      yieldEvery: async () => {
        await ns.asleep(0);
      },
    });
  }
  return chooseMoveMinimax(board, "X", history, Math.min(strategy.depth, config.searchDepth), strategy.weights, deadlineIn(config.moveBudgetMs));
}

/** Plays the current game to the end as black. */
async function playGame(ns: NS, log: Logger, config: GoConfig, strategy: Strategy): Promise<GameResult> {
  const started = Date.now();
  const opponent = ns.go.getOpponent();
  const start = ns.go.getBoardState();
  // Every earlier position (for the no-repeat rule), fetched once - a game
  // a restart left half-played has some - then extended as we play rather
  // than copied out of the game again every move.
  const history: Board[] = ns.go.getMoveHistory();
  const resumed = history.length > 0;
  const line: string[] = [];
  const record = (color: "X" | "O", r: { type: string; x: number | null; y: number | null }): void => {
    if (r.type === "move" && r.x !== null && r.y !== null) line.push(`${color}${r.x}${r.y}`);
    else if (r.type === "pass") line.push(`${color}pass`);
  };
  const before = ns.go.analysis.getStats()[opponent];
  const winsBefore = before?.wins ?? 0;
  // A cap on our own moves - the game ends long before this; it only
  // guards against a position the engine misreads forever.
  const maxMoves = config.boardSize * config.boardSize * 3;
  for (let moves = 0; ns.go.getCurrentPlayer() !== "None"; moves++) {
    if (ns.go.getCurrentPlayer() === "White") {
      record("O", await ns.go.opponentNextTurn(false));
      // Awaiting an already-resolved promise doesn't let the game run: if
      // the game says White is to move but the turn promise is already
      // settled (the game leaves it resolved to gameOver in some states),
      // this loop would spin and freeze the game. A real pause each time
      // the opponent still hasn't moved breaks that.
      if (ns.go.getCurrentPlayer() === "White") await ns.asleep(WHITE_WAIT_MS);
      continue;
    }
    const passed = ns.go.getGameState().previousMove === null && moves > 0;
    const board = ns.go.getBoardState();
    const choice: MoveChoice = moves < maxMoves ? await nextMove(ns, config, strategy, opponent, passed, board, history) : { kind: "pass" };
    let result;
    let refused = false;
    try {
      result = choice.kind === "move" ? await ns.go.makeMove(choice.x, choice.y) : await ns.go.passTurn();
    } catch (e) {
      // The game refused the move (a rule the engine doesn't model): pass instead.
      await log.warn(`[Go] Move refused (${String(e)}); passing.`);
      refused = true;
      result = await ns.go.passTurn();
    }
    line.push(choice.kind === "move" && !refused ? `X${choice.x}${choice.y}` : "Xpass");
    if (choice.kind === "move" && !refused) {
      history.push(board);
      const after = play(board, choice.x, choice.y, "X");
      if (after) history.push(after);
    }
    record("O", result);
    if (result.type === "gameOver") break;
  }
  const after = ns.go.analysis.getStats()[opponent];
  const { blackScore, whiteScore, komi } = ns.go.getGameState();
  const size = ns.go.getBoardState().length;
  const won = (after?.wins ?? 0) > winsBefore;
  return {
    start,
    resumed,
    line,
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

  // Resting because the bonus has flattened (logged once per rest).
  let resting = false;
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

    let redeals = 0;
    if (ns.go.getCurrentPlayer() === "None") {
      const weights = { ...readPhasePolicy(ns).goWeights, ...config.opponentWeights };
      const gamesPlayed = Object.fromEntries(Object.entries(ns.go.analysis.getStats()).map(([name, s]) => [name, s.wins + s.losses]));
      const best = bestOpponent(weights, state.records, gamesPlayed, unavailable, config.boardSize);
      if (best && bonusPctPerHour(best.rate) < config.minBonusPctPerHour) {
        if (!resting) await log.info(`[Go] Bonus has flattened (best: ${best.name}, ${bonusPctPerHour(best.rate).toFixed(2)}%/h); resting ${config.restMinutes}m between checks.`);
        resting = true;
        await ns.asleep(config.restMinutes * 60_000);
        continue;
      }
      resting = false;
      const next = best?.name;
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
      // A bad deal (shouldRedeal) is reset before our first move. That's
      // free by the game's docs; checked anyway - if a redeal ever changes
      // the record or the streak, redealing stops for good.
      for (; !state.redealCostly && redeals < MAX_REDEALS && shouldRedeal(next, board); redeals++) {
        const before = ns.go.analysis.getStats()[next as GoOpponentName];
        board = ns.go.resetBoardState(next as GoOpponentName, config.boardSize) ?? board;
        const after = ns.go.analysis.getStats()[next as GoOpponentName];
        const changed = (before?.wins ?? 0) !== (after?.wins ?? 0) || (before?.losses ?? 0) !== (after?.losses ?? 0) || (before?.winStreak ?? 0) !== (after?.winStreak ?? 0);
        if (changed) {
          state = { ...state, redealCostly: true };
          ns.write(GO_STATE_PATH, JSON.stringify(state), "w");
          await log.warn(`[Go] Redealing ${next}'s board changed its record (${JSON.stringify(before)} -> ${JSON.stringify(after)}); not redealing again.`);
          break;
        }
        await log.info(`[Go] Redealt ${next}'s board (handicap on the center point).`);
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
      redealCostly: state.redealCostly,
    };
    ns.write(GO_STATE_PATH, JSON.stringify(state), "w");
    ns.write(
      GO_HISTORY_PATH,
      appendHistory(ns.read(GO_HISTORY_PATH), {
        at: Date.now(),
        opponent,
        strategy: strategy.name,
        size: game.start.length,
        start: game.start,
        resumed: game.resumed,
        redeals,
        line: game.line,
        blackScore: game.blackScore,
        whiteScore: game.whiteScore,
        won,
        power: game.power,
        seconds: game.seconds,
      }),
      "w"
    );
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
