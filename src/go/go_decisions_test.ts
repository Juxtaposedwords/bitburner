import { chooseMoveModeled } from "go/go_opponent_model";
import { describe, expect, it } from "vitest";
import { appendHistory, bonusFor, chooseMove, chooseMoveMinimax, difficultyMultiplier, evaluateMove, nodePowerGained, OpponentRecord, pickOpponentByValue, powerNow, recordGame, recordResult, RESULT_WINDOW, winStreakMultiplier } from "go/go_decisions";

describe("chooseMove", () => {
  it("captures when it can", () => {
    const board = [".....", "..X..", ".XO..", "..X..", "....."];
    expect(chooseMove(board, "X")).toMatchObject({ kind: "move", x: 2, y: 3 });
  });

  it("rescues a chain in atari", () => {
    const board = [".....", "..O..", ".OX..", "..O..", "....."];
    expect(chooseMove(board, "X")).toMatchObject({ kind: "move", x: 2, y: 3 });
  });

  it("opens away from the edge", () => {
    const move = chooseMove([".....", ".....", ".....", ".....", "....."], "X");
    expect(move.kind).toBe("move");
    if (move.kind === "move") {
      expect(move.x).toBeGreaterThanOrEqual(1);
      expect(move.x).toBeLessThanOrEqual(3);
      expect(move.y).toBeGreaterThanOrEqual(1);
      expect(move.y).toBeLessThanOrEqual(3);
    }
  });

  it("passes when only its own eyes are left", () => {
    const board = [".XXXX", "XXXXX", "XX.XX", "XXXXX", "XXXX."];
    expect(chooseMove(board, "X")).toEqual({ kind: "pass" });
  });
});

describe("evaluateMove", () => {
  it("won't put its own chain in atari without capturing", () => {
    const board = [".O...", "O....", ".....", ".....", "....."];
    expect(evaluateMove(board, 0, 0, "X")).toBeUndefined();
  });

  it("won't drop a weak stone into the opponent's territory", () => {
    const board = [".....", "OOOOO", ".....", ".....", "....."];
    expect(evaluateMove(board, 0, 2, "X")).toBeUndefined();
  });
});

describe("pickOpponentByValue", () => {
  const record = (power: number, games: number, perGame = 100, seconds = 10): OpponentRecord => ({ games, power, totalGames: 10, totalPower: perGame * 10, totalSeconds: seconds * 10 });

  it("plays the opponent the phase weights most when nothing is built up", () => {
    expect(pickOpponentByValue({ Daedalus: 1, Netburners: 0.1 }, {}, {}, new Set(), 5)).toBe("Daedalus");
  });

  it("moves on once an opponent's bonus has flattened", () => {
    const records = { Daedalus: record(1e6, 50) };
    expect(pickOpponentByValue({ Daedalus: 1, Illuminati: 0.7 }, records, { Daedalus: 50 }, new Set(), 5)).toBe("Illuminati");
  });

  it("treats an install (fewer games played than recorded) as zero power", () => {
    const records = { Daedalus: record(1e6, 50) };
    expect(powerNow(records.Daedalus, 0)).toBe(0);
    expect(pickOpponentByValue({ Daedalus: 1, Illuminati: 0.7 }, records, { Daedalus: 0 }, new Set(), 5)).toBe("Daedalus");
  });

  it("skips unavailable, unweighted and unknown opponents", () => {
    expect(pickOpponentByValue({ Daedalus: 1, Tetrads: 0, Nobody: 5 }, {}, {}, new Set(["Daedalus"]), 5)).toBeUndefined();
  });
});

describe("recordGame", () => {
  it("adds to the power since the last install, and to the totals", () => {
    const once = recordGame({}, "Daedalus", 40, 10, 1);
    const twice = recordGame(once, "Daedalus", 60, 12, 2);
    expect(twice.Daedalus).toEqual({ games: 2, power: 100, totalGames: 2, totalPower: 100, totalSeconds: 22 });
  });

  it("starts the power over after an install", () => {
    const before = recordGame(recordGame({}, "Daedalus", 40, 10, 1), "Daedalus", 60, 12, 2);
    expect(recordGame(before, "Daedalus", 30, 10, 1).Daedalus).toMatchObject({ games: 1, power: 30, totalGames: 3 });
  });
});

describe("bonusFor", () => {
  it("grows ever more slowly with power", () => {
    expect(bonusFor(0, 1)).toBe(0);
    expect(bonusFor(100, 1) - bonusFor(0, 1)).toBeGreaterThan(bonusFor(200, 1) - bonusFor(100, 1));
  });
});

describe("recordResult", () => {
  it("keeps only the recent window", () => {
    let results: Record<string, boolean[]> = {};
    for (let i = 0; i < RESULT_WINDOW + 5; i++) results = recordResult(results, "Netburners", i % 2 === 0);
    expect(results.Netburners).toHaveLength(RESULT_WINDOW);
  });
});

describe("node power (the game's formula)", () => {
  it("pays 8x for a 5x5 board against Illuminati, (komi + 0.5) / 4 otherwise", () => {
    expect(difficultyMultiplier(7.5, 5)).toBe(8);
    expect(difficultyMultiplier(7.5, 7)).toBe(2);
    expect(difficultyMultiplier(5.5, 5)).toBe(1.5);
  });

  it("halves a loss and rewards streaks", () => {
    expect(winStreakMultiplier(-1, 2)).toBe(0.5);
    expect(winStreakMultiplier(3, 2)).toBe(1.75);
    expect(winStreakMultiplier(1, -4)).toBe(3);
  });

  it("multiplies the score by both", () => {
    expect(nodePowerGained(10, 7.5, 5, -1, -1)).toBe(40);
  });
});

describe("opponent priors", () => {
  it("gets to Illuminati once Daedalus is built up, despite one zero-power game on record", () => {
    const records = {
      Illuminati: { games: 1, power: 0, totalGames: 1, totalPower: 0, totalSeconds: 0.6 },
      Daedalus: { games: 20, power: 600, totalGames: 20, totalPower: 600, totalSeconds: 200 },
    };
    expect(pickOpponentByValue({ Daedalus: 1, Illuminati: 0.7 }, records, { Illuminati: 1, Daedalus: 20 }, new Set(), 5)).toBe("Illuminati");
  });
});

describe("appendHistory", () => {
  const entry = (at: number) => ({ at, opponent: "Daedalus", strategy: "model", size: 5, start: ["....."], resumed: false, redeals: 0, line: ["X22", "Opass"], blackScore: 20, whiteScore: 5.5, won: true, power: 40, seconds: 9 });

  it("adds a game as a JSON line", () => {
    const raw = appendHistory("", entry(1));
    expect(JSON.parse(raw.trim()).at).toBe(1);
  });

  it("keeps only the newest games", () => {
    let raw = "";
    for (let i = 0; i < 5; i++) raw = appendHistory(raw, entry(i), 3);
    expect(raw.trim().split("\n").map((l) => JSON.parse(l).at)).toEqual([2, 3, 4]);
  });
});

describe("move deadlines", () => {
  const board = [".....", "..X..", ".XO..", "..X..", "....."];
  const past = { at: 0 };

  it("still plays a move (the best by the quick evaluation) when the deadline has already passed", async () => {
    expect(chooseMoveMinimax(board, "X", [], 3, undefined, past).kind).toBe("move");
    expect((await chooseMoveModeled("Illuminati", board, "X", [], { deadline: past })).kind).toBe("move");
  });
});

describe("resting once the bonus flattens", () => {
  it("rates a fresh opponent far above a built-up one, in %/hour", async () => {
    const { bestOpponent, bonusPctPerHour } = await import("go/go_decisions");
    const fresh = bestOpponent({ Daedalus: 1 }, {}, {}, new Set(), 5);
    const built = bestOpponent(
      { Daedalus: 1 },
      { Daedalus: { games: 5000, power: 1e7, totalGames: 5000, totalPower: 5000 * 34, totalSeconds: 5000 * 10 } },
      { Daedalus: 5000 },
      new Set(),
      5
    );
    expect(bonusPctPerHour(fresh!.rate)).toBeGreaterThan(100);
    expect(bonusPctPerHour(built!.rate)).toBeLessThan(1);
  });
});
