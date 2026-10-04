import { describe, expect, it } from "vitest";
import { chooseMove, difficultyMultiplier, evaluateMove, nodePowerGained, pickOpponent, recordResult, RESULT_WINDOW, winStreakMultiplier } from "go/go_decisions";

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

describe("pickOpponent", () => {
  const priority = ["Illuminati", "Daedalus", "Netburners"];

  it("takes the first available opponent", () => {
    expect(pickOpponent(priority, {}, new Set(["Illuminati"]), 10, 0.25)).toBe("Daedalus");
  });

  it("skips an opponent we lose to too often, once there are enough games", () => {
    const results = { Illuminati: Array(10).fill(false), Daedalus: [false, false] };
    expect(pickOpponent(priority, results, new Set(), 10, 0.25)).toBe("Daedalus");
  });

  it("falls back to the best win rate when every opponent is losing", () => {
    const results = { Illuminati: Array(10).fill(false), Daedalus: Array(10).fill(false), Netburners: [...Array(8).fill(false), true, true] };
    expect(pickOpponent(priority, results, new Set(), 10, 0.25)).toBe("Netburners");
  });

  it("is undefined with nothing available", () => {
    expect(pickOpponent(priority, {}, new Set(priority), 10, 0.25)).toBeUndefined();
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
