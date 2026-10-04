import { describe, expect, it } from "vitest";
import { canonical, moveKey, openingValue, parseBook, pickBookMove, prunePositions, recordOpening, transformBoard, TRANSFORMS, emptyBook } from "go/go_book";

const board = ["X....", ".O...", "..#..", ".....", "....O"];

describe("symmetry", () => {
  it("gives every rotation and reflection the same canonical key", () => {
    const keys = TRANSFORMS.map((_, t) => canonical(transformBoard(board, t)).key);
    expect(new Set(keys).size).toBe(1);
  });

  it("puts a move's key on the same point of the canonical board from any orientation", () => {
    const place = (b: string[], x: number, y: number): string[] => b.map((col, i) => (i === x ? col.slice(0, y) + "X" + col.slice(y + 1) : col));
    const after = canonical(place(board, 0, 1)).key;
    for (let t = 0; t < TRANSFORMS.length; t++) {
      const turned = transformBoard(board, t);
      const [mx, my] = TRANSFORMS[t](0, 1, 5);
      const c = canonical(turned);
      const [kx, ky] = moveKey(mx, my, 5, c.transform).split(",").map(Number);
      expect(canonical(place(c.key.split("/"), kx, ky)).key).toBe(after);
    }
  });
});

describe("pickBookMove", () => {
  it("tries each candidate once, in engine order", () => {
    expect(pickBookMove(["a", "b", "c"], undefined)).toBe(0);
    expect(pickBookMove(["a", "b", "c"], { a: [1, 10] })).toBe(1);
  });

  it("then plays the best average", () => {
    expect(pickBookMove(["a", "b", "c"], { a: [20, 200], b: [20, 900], c: [20, 100] })).toBe(1);
  });
});

describe("recordOpening", () => {
  it("credits every opening move with the game's value", () => {
    const book = recordOpening(emptyBook(), [{ position: "p", move: "1,1" }, { position: "q", move: "2,2" }], 50);
    const again = recordOpening(book, [{ position: "p", move: "1,1" }], 30);
    expect(again.positions.p["1,1"]).toEqual([2, 80]);
    expect(again.positions.q["2,2"]).toEqual([1, 50]);
  });

  it("keeps the most-played positions when over the limit", () => {
    const pruned = prunePositions({ a: { m: [5, 1] }, b: { m: [1, 1] }, c: { m: [3, 1] } }, 2);
    expect(Object.keys(pruned).sort()).toEqual(["a", "c"]);
  });

  it("reads a missing or corrupt file as empty", () => {
    expect(parseBook("")).toEqual(emptyBook());
    expect(parseBook("{oops")).toEqual(emptyBook());
  });
});

describe("openingValue", () => {
  it("fixes the streak part: 1.25 for a win, 0.5 for a loss", () => {
    expect(openingValue(20, 8, true)).toBe(200);
    expect(openingValue(20, 8, false)).toBe(80);
  });
});
