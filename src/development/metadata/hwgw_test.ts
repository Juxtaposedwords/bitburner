import { describe, expect, it } from "vitest";
import { batchesPerTick, driftVerdict, allocateAcrossHosts, computeBatchPlan, decidePrepAction, homeWorkerCapacity, homeWorkerRam, nextHackFraction, prepThreadsNeeded, selectTargets } from "development/metadata/hwgw";

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
  it("shifts every delay later when actions are too fast for hack's delay to stay non-negative", () => {
    const fast = { ...baseInputs, hackTime: 5, growTime: 16, weakenTime: 20 };
    const plan = computeBatchPlan(fast, 200);
    const delays = [plan.hackDelayMs, plan.weaken1DelayMs, plan.growDelayMs, plan.weaken2DelayMs];
    expect(Math.min(...delays)).toBe(0);
    // Completion times keep order and 200ms spacing.
    const ends = [plan.hackDelayMs + 5, plan.weaken1DelayMs + 20, plan.growDelayMs + 16, plan.weaken2DelayMs + 20];
    expect(ends).toEqual([ends[0], ends[0] + 200, ends[0] + 400, ends[0] + 600]);
    expect(plan.totalDurationMs).toBe(ends[3]);
  });

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
  it("round-robins a request across every host with room, one thread per host per pass", () => {
    const candidates = [
      { host: "small-server", freeRam: 10 },
      { host: "big-server", freeRam: 100 },
    ];
    const requests = [{ threads: 5, ramPerThread: 2 }];

    // 3 passes give small-server a thread each time (it still has room);
    // big-server only gets 2 before threadsLeft hits 0 mid-pass-3.
    expect(allocateAcrossHosts(candidates, requests)).toEqual([
      [
        { host: "small-server", threads: 3 },
        { host: "big-server", threads: 2 },
      ],
    ]);
  });

  it("a request smaller than the candidate count only touches as many hosts as it needs", () => {
    const candidates = [
      { host: "a", freeRam: 10 },
      { host: "b", freeRam: 10 },
      { host: "c", freeRam: 10 },
      { host: "d", freeRam: 10 },
      { host: "e", freeRam: 10 },
    ];
    const requests = [{ threads: 2, ramPerThread: 2 }];

    // Round-robin doesn't manufacture work to keep every host busy - a
    // 2-thread request only ever lands on 2 hosts, not all 5.
    expect(allocateAcrossHosts(candidates, requests)).toEqual([
      [
        { host: "a", threads: 1 },
        { host: "b", threads: 1 },
      ],
    ]);
  });

  it("a request large enough to need every host spreads evenly across all of them, not just the biggest", () => {
    const candidates = [
      { host: "a", freeRam: 10 },
      { host: "b", freeRam: 10 },
      { host: "c", freeRam: 10 },
    ];
    const requests = [{ threads: 12, ramPerThread: 2 }]; // needs 24 total - no single host has it, three combined do

    expect(allocateAcrossHosts(candidates, requests)).toEqual([
      [
        { host: "a", threads: 4 },
        { host: "b", threads: 4 },
        { host: "c", threads: 4 },
      ],
    ]);
  });

  it("tracks reservations across requests - a host that ran out of room in an earlier request is skipped, not retried", () => {
    const candidates = [
      { host: "a", freeRam: 10 },
      { host: "b", freeRam: 10 },
    ];
    const requests = [
      { threads: 5, ramPerThread: 2 }, // round-robins to a=3, b=2 (a has slightly more headroom used, see first case)
      { threads: 5, ramPerThread: 2 }, // a only has 4 GB (2 threads) left; b picks up the rest
    ];

    expect(allocateAcrossHosts(candidates, requests)).toEqual([
      [
        { host: "a", threads: 3 },
        { host: "b", threads: 2 },
      ],
      [
        { host: "a", threads: 2 },
        { host: "b", threads: 3 },
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

describe("nextHackFraction", () => {
  it("raises the fraction while worker RAM is under the target", () => {
    expect(nextHackFraction(0.2, 0.5, false, 0.85)).toBeCloseTo(0.25);
  });

  it("lowers it when batches stopped fitting or the fleet is full", () => {
    expect(nextHackFraction(0.2, 0.5, true, 0.85)).toBeCloseTo(0.17);
    expect(nextHackFraction(0.2, 0.97, false, 0.85)).toBeCloseTo(0.17);
  });

  it("holds it between the target and full", () => {
    expect(nextHackFraction(0.2, 0.9, false, 0.85)).toBe(0.2);
  });

  it("stays within bounds", () => {
    expect(nextHackFraction(0.85, 0.1, false, 0.85)).toBe(0.9);
    expect(nextHackFraction(0.01, 0.99, true, 0.85)).toBe(0.01);
  });
});

describe("homeWorkerRam", () => {
  it("uses all but reservedGb below the fallback level (fresh BitNode)", () => {
    expect(homeWorkerRam(32, 10, 20, 50, 5)).toBe(17);
  });

  it("keeps a small home free past the fallback level", () => {
    expect(homeWorkerRam(32, 10, 500, 50, 5)).toBe(0);
  });

  it("uses a big home beyond 10% for the daemons", () => {
    // 16 TB home, 400 GB of daemons: 16384 - 400 - 1638.4
    expect(homeWorkerRam(16384, 400, 500, 50, 5)).toBeCloseTo(14345.6, 1);
    expect(homeWorkerCapacity(16384, 500, 50, 5)).toBeCloseTo(14745.6, 1);
  });
});

describe("selectTargets", () => {
  const HOLD = 20 * 60_000;
  const NOW = 100 * 60_000;

  it("fills up to k from the ranking, best first", () => {
    expect(selectTargets([], ["ecorp", "megacorp", "blade", "the-hub"], 3, NOW, HOLD).map((t) => t.host)).toEqual(["ecorp", "megacorp", "blade"]);
  });

  it("keeps a young target still being prepped that dropped out of the top k, and drops an old one", () => {
    const current = [
      { host: "the-hub", since: NOW - 5 * 60_000 },
      { host: "omega-net", since: NOW - 60 * 60_000 },
    ];
    const ranked = ["ecorp", "megacorp", "the-hub", "omega-net"];
    expect(selectTargets(current, ranked, 2, NOW, HOLD, new Set(["the-hub", "omega-net"])).map((t) => t.host)).toEqual(["ecorp", "the-hub"]);
  });

  it("gives a prepped small target's slot to a better one at once", () => {
    const current = [{ host: "the-hub", since: NOW - 60_000 }];
    expect(selectTargets(current, ["ecorp", "megacorp", "the-hub"], 2, NOW, HOLD, new Set()).map((t) => t.host)).toEqual(["ecorp", "megacorp"]);
  });

  it("drops targets no longer ranked (lost root)", () => {
    expect(selectTargets([{ host: "gone", since: NOW }], ["ecorp"], 2, NOW, HOLD).map((t) => t.host)).toEqual(["ecorp"]);
  });

  it("keeps a target's since across ticks", () => {
    const first = selectTargets([], ["ecorp"], 1, NOW, HOLD);
    expect(selectTargets(first, ["ecorp"], 1, NOW + 1000, HOLD)[0].since).toBe(NOW);
  });
});

describe("prepThreadsNeeded", () => {
  it("weakens just to min security, and grows by the threads asked", () => {
    expect(prepThreadsNeeded("weaken", 72, 0.05, 0)).toBe(1440);
    expect(prepThreadsNeeded("grow", 0, 0.05, 1234.2)).toBe(1235);
  });
});

describe("batchesPerTick", () => {
  it("fits as many 4-action windows as the tick allows, at least one", () => {
    expect(batchesPerTick(1000, 200)).toBe(1);
    expect(batchesPerTick(1000, 50)).toBe(5);
    expect(batchesPerTick(1000, 0)).toBe(1);
  });
});

describe("driftVerdict", () => {
  it("ignores a mid-batch dip, counting it toward a streak", () => {
    expect(driftVerdict(0, 33.01, 33, 1e11, 1e12, 10)).toEqual({ drifted: false, streak: 1 });
  });

  it("calls drift after streakTicks off readings in a row, and resets on a clean one", () => {
    expect(driftVerdict(9, 33.01, 33, 1e11, 1e12, 10)).toEqual({ drifted: true, streak: 0 });
    expect(driftVerdict(5, 33, 33, 1e12, 1e12, 10)).toEqual({ drifted: false, streak: 0 });
  });

  it("calls drift at once when security climbs well past min", () => {
    expect(driftVerdict(0, 40, 33, 1e12, 1e12, 10)).toEqual({ drifted: true, streak: 0 });
  });
});
