import { describe, expect, it } from "vitest";
import { allocateAcrossHosts, computeBatchPlan, decidePrepAction } from "development/metadata/hwgw";

// hackTime = 1000ms, growTime = 3.2x, weakenTime = 4x — the fixed ratios
// Bitburner uses for a given security/hacking-level snapshot.
const baseInputs = {
  hackThreads: 10.5,
  hackSecurityIncrease: 0.5,
  growThreads: 25.3,
  growSecurityIncrease: 1.2,
  weakenSecurityPerThread: 0.05,
  hackTime: 1000,
  growTime: 3200,
  weakenTime: 4000,
};

describe("computeBatchPlan", () => {
  it("rounds fractional thread counts up (partial threads aren't launchable)", () => {
    const plan = computeBatchPlan(baseInputs, 200);

    expect(plan.hackThreads).toBe(11);
    expect(plan.growThreads).toBe(26);
  });

  it("derives weaken thread counts from the security increase they need to cancel", () => {
    const plan = computeBatchPlan(baseInputs, 200);

    expect(plan.weaken1Threads).toBe(10); // ceil(0.5 / 0.05)
    expect(plan.weaken2Threads).toBe(24); // ceil(1.2 / 0.05)
  });

  it("schedules delays so all four actions complete in order, spacingMs apart", () => {
    const plan = computeBatchPlan(baseInputs, 200);

    expect(plan.weaken1DelayMs).toBe(0);
    expect(plan.hackDelayMs).toBe(2800); // 4000 - 200 - 1000
    expect(plan.growDelayMs).toBe(1000); // 4000 + 200 - 3200
    expect(plan.weaken2DelayMs).toBe(400); // 2 * 200

    // Completion order: hack, then weaken1, then grow, then weaken2.
    const hackFinish = baseInputs.hackTime + plan.hackDelayMs;
    const weaken1Finish = baseInputs.weakenTime + plan.weaken1DelayMs;
    const growFinish = baseInputs.growTime + plan.growDelayMs;
    const weaken2Finish = baseInputs.weakenTime + plan.weaken2DelayMs;

    expect(hackFinish).toBeLessThan(weaken1Finish);
    expect(weaken1Finish).toBeLessThan(growFinish);
    expect(growFinish).toBeLessThan(weaken2Finish);
    expect(weaken1Finish).toBe(hackFinish + 200);
    expect(growFinish).toBe(weaken1Finish + 200);
    expect(weaken2Finish).toBe(growFinish + 200);
  });

  it("never produces a negative delay", () => {
    const plan = computeBatchPlan(baseInputs, 200);

    expect(plan.hackDelayMs).toBeGreaterThanOrEqual(0);
    expect(plan.weaken1DelayMs).toBeGreaterThanOrEqual(0);
    expect(plan.growDelayMs).toBeGreaterThanOrEqual(0);
    expect(plan.weaken2DelayMs).toBeGreaterThanOrEqual(0);
  });

  it("computes totalDurationMs as weaken2's completion offset from launch", () => {
    const plan = computeBatchPlan(baseInputs, 200);

    expect(plan.totalDurationMs).toBe(4400); // 4000 + 2*200
  });
});

describe("decidePrepAction", () => {
  it.each([
    { name: "security above minimum", security: 10, minSecurity: 5, money: 1000, maxMoney: 1000, expected: "weaken" },
    { name: "security at minimum, money below max", security: 5, minSecurity: 5, money: 500, maxMoney: 1000, expected: "grow" },
    { name: "security and money both settled", security: 5, minSecurity: 5, money: 1000, maxMoney: 1000, expected: "done" },
    { name: "security takes priority over money", security: 10, minSecurity: 5, money: 500, maxMoney: 1000, expected: "weaken" },
    { name: "small overshoot within tolerance counts as done", security: 5.005, minSecurity: 5, money: 999, maxMoney: 1000, expected: "done" },
  ])("$name", ({ security, minSecurity, money, maxMoney, expected }) => {
    expect(decidePrepAction(security, minSecurity, money, maxMoney)).toBe(expected);
  });
});

describe("allocateAcrossHosts", () => {
  it("places a request entirely on the first host with enough room", () => {
    const candidates = [
      { host: "small-server", freeRam: 10 },
      { host: "big-server", freeRam: 100 },
    ];
    const requests = [{ threads: 5, ramPerThread: 2 }]; // needs 10

    expect(allocateAcrossHosts(candidates, requests)).toEqual([[{ host: "small-server", threads: 5 }]]);
  });

  it("tracks reservations across requests, spilling onto the next host once one fills up", () => {
    const candidates = [
      { host: "a", freeRam: 10 },
      { host: "b", freeRam: 10 },
    ];
    const requests = [
      { threads: 5, ramPerThread: 2 }, // needs 10 - exactly fills "a"
      { threads: 5, ramPerThread: 2 }, // needs 10 - "a" now has 0 left, spills to "b"
    ];

    expect(allocateAcrossHosts(candidates, requests)).toEqual([
      [{ host: "a", threads: 5 }],
      [{ host: "b", threads: 5 }],
    ]);
  });

  it("splits a single request's threads across multiple hosts when no one host holds it all", () => {
    const candidates = [
      { host: "a", freeRam: 10 },
      { host: "b", freeRam: 10 },
      { host: "c", freeRam: 10 },
    ];
    const requests = [{ threads: 12, ramPerThread: 2 }]; // needs 24 total - no single host has it, three combined do

    expect(allocateAcrossHosts(candidates, requests)).toEqual([
      [
        { host: "a", threads: 5 },
        { host: "b", threads: 5 },
        { host: "c", threads: 2 },
      ],
    ]);
  });

  it("returns undefined (abort the whole batch) if a request's full thread count can't be placed even after spreading across every host", () => {
    const candidates = [{ host: "a", freeRam: 10 }];
    const requests = [
      { threads: 5, ramPerThread: 1 }, // needs 5, fits
      { threads: 100, ramPerThread: 1 }, // needs 100, doesn't fit anywhere
    ];

    expect(allocateAcrossHosts(candidates, requests)).toBeUndefined();
  });

  it("returns an empty allocation for an empty request list", () => {
    expect(allocateAcrossHosts([{ host: "a", freeRam: 10 }], [])).toEqual([]);
  });

  it("returns undefined when there are no candidate hosts at all", () => {
    expect(allocateAcrossHosts([], [{ threads: 1, ramPerThread: 1 }])).toBeUndefined();
  });

  it("treats a zero-thread request as trivially satisfied with an empty placement list", () => {
    expect(allocateAcrossHosts([{ host: "a", freeRam: 10 }], [{ threads: 0, ramPerThread: 2 }])).toEqual([[]]);
  });
});
