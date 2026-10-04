import { describe, expect, it } from "vitest";
import { area, chainAt, chainsOf, neighbors, play, territory } from "go/go_engine";

// Columns, board[x][y]; drawn here with x as the row of the literal.
const capturable = [".....", "..X..", ".XO..", "..X..", "....."];

describe("neighbors", () => {
  it("skips edges and dead nodes", () => {
    expect(neighbors(["#..", "...", "..."], 0, 1)).toEqual([
      [1, 1],
      [0, 2],
    ]);
  });
});

describe("chainAt", () => {
  it("collects a chain and its liberties", () => {
    const chain = chainAt(["XX...", ".....", ".....", ".....", "....."], 0, 0);
    expect(chain.stones).toHaveLength(2);
    expect(chain.liberties.size).toBe(3);
  });

  it("finds every chain of a color", () => {
    expect(chainsOf(capturable, "X")).toHaveLength(3);
  });
});

describe("play", () => {
  it("captures a chain left without liberties", () => {
    const next = play(capturable, 2, 3, "X");
    expect(next?.[2]).toBe(".X.X.");
  });

  it("refuses suicide, an occupied point and a repeated board", () => {
    const surrounded = [".....", "..O..", ".O.O.", "..O..", "....."];
    expect(play(surrounded, 2, 2, "X")).toBeUndefined();
    expect(play(capturable, 1, 2, "O")).toBeUndefined();
    const next = play(capturable, 2, 3, "X") as string[];
    expect(play(capturable, 2, 3, "X", [next])).toBeUndefined();
  });

  it("allows a move with no liberties of its own when it captures", () => {
    const board = [".OX..", "OX...", ".....", ".....", "....."];
    expect(play(board, 0, 0, "X")?.[0]).toBe("X.X..");
  });
});

describe("territory and area", () => {
  it("gives an empty region to the only color bordering it", () => {
    const walls = [".....", "XXXXX", ".....", "OOOOO", "....."];
    const owners = territory(walls);
    expect(owners.get("0,0")).toBe("X");
    expect(owners.get("2,0")).toBe("?");
    expect(owners.get("4,4")).toBe("O");
    expect(area(walls, "X")).toBe(10);
    expect(area(walls, "O")).toBe(10);
  });
});
