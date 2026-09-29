import { describe, expect, it } from "vitest";
import { checkStatus, logLineSeconds, StatusSnapshot, summarizeScheduler } from "tools/status_checks";

const NOW = 10_000_000;
const base = (overrides: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  nowMs: NOW,
  running: ["a.js", "b.js"],
  expected: [
    { script: "a.js", core: true },
    { script: "b.js", core: false },
  ],
  cash: 1e12,
  rates: { hacking: 1e9 },
  schedulerLogTail: ["[Scheduler] Fired batch on silver-helix: H7@a/W1@a/G3@a/W1@a."],
  ...overrides,
});
const messages = (s: StatusSnapshot) => checkStatus(s).map((f) => `${f.level}: ${f.message}`);

describe("checkStatus", () => {
  it("is quiet when everything's healthy", () => {
    expect(checkStatus(base())).toEqual([]);
  });

  it("flags missing daemons, core ones as errors", () => {
    const found = messages(base({ running: [] }));
    expect(found[0]).toMatch(/^ERROR: a\.js is not running/);
    expect(found[1]).toMatch(/^WARN: b\.js is not running/);
  });

  it("flags batches with no second weaken", () => {
    const found = messages(base({ schedulerLogTail: ["[Scheduler] Fired batch on x: H7@a/W1@a/G3@a/W0."] }));
    expect(found[0]).toMatch(/^ERROR: Batches are firing with no second weaken/);
  });

  it("flags a scheduler stuck on 'not hackable'", () => {
    const tail = Array.from({ length: 6 }, () => "[Scheduler] phantasy not hackable for hackFraction 0.05 right now");
    const found = messages(base({ schedulerLogTail: tail }));
    expect(found.some((m) => m.startsWith("WARN: Scheduler logged \"not hackable\" 6 times"))).toBe(true);
    expect(found.some((m) => m.startsWith("WARN: Scheduler's recent log shows no batches"))).toBe(true);
  });

  it("flags the gang stand-down", () => {
    expect(messages(base({ gangCasualties: { casualties: 12, maxCasualties: 1 } }))[0]).toMatch(/^ERROR: Gang stand-down: 12 casualties/);
  });

  it("flags working a faction with nothing useful left", () => {
    const faction = { workTarget: "Netburners", repTargets: { CyberSec: 37500 }, favorPlan: [], writtenAt: NOW };
    expect(messages(base({ faction }))).toContain("WARN: Working for Netburners, which has no useful rep target left.");
  });

  it("warns when a savings target is more than a day away", () => {
    const found = messages(base({ cash: 1e11, savings: { amount: 5.26e12, reason: "Embedded Netburner Module" }, rates: { hacking: 1, cash: 1e9 } }));
    expect(found[0]).toMatch(/^WARN: Saving for Embedded Netburner Module: \$5160\.0B to go, ~3\.6d/);
  });

  it("flags stale status files and idle sleeves", () => {
    const found = messages(base({ sleeves: { sleeves: [{ index: 0, goal: "idle" }], writtenAt: NOW - 5 * 60_000 } }));
    expect(found).toContain("WARN: /var/sleeves.txt is 5m old - its daemon may have stopped.");
    expect(found).toContain("WARN: Sleeve 0 is idle.");
  });

  it("reports karma progress with an ETA", () => {
    const faction = { karmaCrime: "Homicide (80% success, karma -11791 / -54000)", writtenAt: NOW };
    expect(messages(base({ faction, rates: { hacking: 1, karma: 44 } }))).toContain(
      "info: Gang karma: Homicide (80% success, karma -11791 / -54000), ~16.0h to go."
    );
  });
});

describe("income collapse and falling cash", () => {
  it("warns when hacking income drops well below its 3h baseline", () => {
    const found = messages(base({ rates: { hacking: 44.7e6 }, hackingBaseline: 2.3e9 }));
    expect(found).toContain("WARN: Hacking income dropped to $44.7M/min from $2.3B/min over 3h - see the scheduler section.");
  });

  it("notes falling cash", () => {
    expect(messages(base({ rates: { hacking: 1e9, cash: -7.7e9 } }))).toContain("info: Cash is falling $7.7B/min - spending exceeds income.");
  });
});

describe("logLineSeconds", () => {
  it("parses the log's 12-hour timestamps", () => {
    expect(logLineSeconds("[3:25:35 PM] [PID: 1] [INFO ] x")).toBe(15 * 3600 + 25 * 60 + 35);
    expect(logLineSeconds("[12:00:01 AM] x")).toBe(1);
    expect(logLineSeconds("no timestamp")).toBeUndefined();
  });
});

describe("summarizeScheduler", () => {
  it("finds the target, batch rate, and last warning", () => {
    const lines = [
      "[7:43:31 PM] [PID: 1] [INFO ] [Scheduler] [Scheduler] Fired batch on silver-helix: H7@a/W1@a/G3@a/W1@a.",
      "[7:43:40 PM] [PID: 1] [WARN ] [Scheduler] [Scheduler] Batch for silver-helix doesn't fit across 15 worker host(s)",
      "[7:44:31 PM] [PID: 1] [INFO ] [Scheduler] [Scheduler] Fired batch on silver-helix: H7@a/W1@a/G3@a/W1@a.",
    ];
    const summary = summarizeScheduler(lines);
    expect(summary).toMatchObject({ target: "silver-helix", fired: 2, noFit: 1, batchesPerMin: 1 });
    expect(summary.lastWarning).toMatch(/^Batch for silver-helix doesn't fit/);
  });

  it("finds the target from prep and not-hackable lines", () => {
    expect(summarizeScheduler(["[1:00:00 PM] [PID: 1] [DEBUG] [Scheduler] [Scheduler] Prep weaken on ecorp: security=1/1"]).target).toBe("ecorp");
    expect(summarizeScheduler(["[1:00:00 PM] [PID: 1] [WARN ] [Scheduler] [Scheduler] phantasy not hackable for hackFraction 0.05"]).target).toBe("phantasy");
  });
});
