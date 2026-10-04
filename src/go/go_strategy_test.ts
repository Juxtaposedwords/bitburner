import { describe, expect, it } from "vitest";
import { pickStrategy, recordStrategy, STRATEGIES, strategiesFor, strategyValue } from "go/go_strategy";

const candidates = strategiesFor("The Black Hand");

describe("pickStrategy", () => {
  it("tries every candidate once, in order", () => {
    expect(pickStrategy(candidates, undefined)).toBe(candidates[0]);
    expect(pickStrategy(candidates, { [candidates[0].name]: [1, 50] })).toBe(candidates[1]);
  });

  it("then plays the best average", () => {
    const stats = Object.fromEntries(candidates.map((c, i) => [c.name, [30, (i === 1 ? 90 : 30) * 30] as [number, number]]));
    expect(pickStrategy(candidates, stats)).toBe(candidates[1]);
  });
});

describe("recordStrategy", () => {
  it("adds a game to that opponent's strategy", () => {
    const once = recordStrategy({}, "Daedalus", "live", 40);
    expect(recordStrategy(once, "Daedalus", "live", 20).Daedalus.live).toEqual([2, 60]);
  });
});

describe("strategies", () => {
  it("has candidates for every opponent, with unique names", () => {
    for (const list of Object.values(STRATEGIES)) expect(new Set(list.map((s) => s.name)).size).toBe(list.length);
    expect(strategiesFor("Nobody")).toHaveLength(1);
  });

  it("values a game with the streak part fixed", () => {
    expect(strategyValue(20, 8, true)).toBe(200);
    expect(strategyValue(20, 8, false)).toBe(80);
  });
});
