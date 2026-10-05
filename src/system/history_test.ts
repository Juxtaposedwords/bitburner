import { describe, expect, it } from "vitest";
import { appendJsonLine } from "system/history";

describe("appendJsonLine", () => {
  it("adds an entry and keeps only the newest", () => {
    let raw = "";
    for (let i = 0; i < 5; i++) raw = appendJsonLine(raw, { at: i }, 3);
    expect(raw.trim().split("\n").map((l) => JSON.parse(l).at)).toEqual([2, 3, 4]);
  });
});
