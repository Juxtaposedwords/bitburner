import { describe, expect, it } from "vitest";
import { planShareKills, planShareLaunches, shareBonus, shareThreadTarget, shareWanted } from "development/metadata/share_decisions";

describe("shareThreadTarget", () => {
  it("is `fraction` of fleet RAM in whole threads", () => {
    expect(shareThreadTarget(10_000, 0.1, 4)).toBe(250);
  });

  it("is 0 for a zero fraction or a missing worker (0 RAM per thread)", () => {
    expect(shareThreadTarget(10_000, 0, 4)).toBe(0);
    expect(shareThreadTarget(10_000, 0.1, 0)).toBe(0);
  });

  it("caps the fraction at the whole fleet", () => {
    expect(shareThreadTarget(100, 5, 4)).toBe(25);
  });
});

describe("shareBonus", () => {
  it("follows 1 + ln(threads) / 25 - each 10x more threads adds ~9%", () => {
    expect(shareBonus(1)).toBe(1);
    expect(shareBonus(100)).toBeCloseTo(1.184, 3);
    expect(shareBonus(1000)).toBeCloseTo(1.276, 3);
  });

  it("is 1 (no bonus) with no threads", () => {
    expect(shareBonus(0)).toBe(1);
  });
});

describe("planShareLaunches", () => {
  it("fills the roomiest hosts first, as many threads per host as fit", () => {
    const launches = planShareLaunches(
      [
        { host: "small", freeRam: 8 },
        { host: "big", freeRam: 40 },
      ],
      12,
      4
    );
    expect(launches).toEqual([
      { host: "big", threads: 10 },
      { host: "small", threads: 2 },
    ]);
  });

  it("places what fits rather than failing when the fleet is short", () => {
    expect(planShareLaunches([{ host: "a", freeRam: 10 }], 100, 4)).toEqual([{ host: "a", threads: 2 }]);
  });

  it("skips hosts without room for even one thread", () => {
    expect(planShareLaunches([{ host: "a", freeRam: 3 }], 5, 4)).toEqual([]);
  });
});

describe("planShareKills", () => {
  it("kills the smallest processes first until at or below the target", () => {
    const kills = planShareKills(
      [
        { pid: 1, threads: 100 },
        { pid: 2, threads: 10 },
        { pid: 3, threads: 20 },
      ],
      100
    );
    expect(kills).toEqual([2, 3]);
  });

  it("kills everything for a target of 0 (disabled)", () => {
    expect(planShareKills([{ pid: 1, threads: 5 }, { pid: 2, threads: 5 }], 0).sort()).toEqual([1, 2]);
  });

  it("kills nothing when already at or under the target", () => {
    expect(planShareKills([{ pid: 1, threads: 5 }], 10)).toEqual([]);
  });
});

describe("shareWanted", () => {
  it("runs while the player works a faction", () => {
    expect(shareWanted(true, [])).toBe(true);
  });

  it("runs while a sleeve works a faction and the player trains", () => {
    expect(shareWanted(false, ["crime for money: Shoplift", "faction work: Volhaven"])).toBe(true);
  });

  it("stops when nobody does faction work", () => {
    expect(shareWanted(false, ["crime for money: Shoplift"])).toBe(false);
  });
});
