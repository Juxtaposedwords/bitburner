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

  it("flags a stale hacknet status file", () => {
    expect(messages(base({ hacknetWrittenAt: NOW - 49 * 60_000 }))).toContain("WARN: /var/hacknet_status.txt is 49m old - its daemon may have stopped.");
  });

  it("reports karma progress with an ETA", () => {
    const faction = { karmaCrime: "Homicide (80% success, karma -11791 / -54000)", writtenAt: NOW };
    expect(messages(base({ faction, rates: { hacking: 1, karma: 44 } }))).toContain(
      "info: Gang karma: Homicide (80% success, karma -11791 / -54000), ~16.0h to go."
    );
  });
});

describe("missing programs", () => {
  it("errors when openers are missing despite cash", () => {
    expect(messages(base({ cash: 1.49e13, missingPrograms: ["HTTPWorm.exe", "SQLInject.exe"] }))[0]).toMatch(/^ERROR: Missing HTTPWorm.exe, SQLInject.exe with \$14.9T cash/);
    expect(checkStatus(base({ cash: 1e5, missingPrograms: ["SQLInject.exe"] }))).toEqual([]);
  });
});

describe("idle fleet", () => {
  it("warns when batches fire but most of the fleet is idle", () => {
    expect(messages(base({ fleetUsedFraction: 0.01 }))).toContain(
      "WARN: Fleet 1% used while batches fire on silver-helix - the targets can't use the RAM (too few, or too small)."
    );
    expect(checkStatus(base({ fleetUsedFraction: 0.8 }))).toEqual([]);
    // Income above its baseline: low use is just cheap batches.
    expect(checkStatus(base({ fleetUsedFraction: 0.02, rates: { hacking: 3e14 }, hackingBaseline: 1e14 }))).toEqual([]);
  });
});

describe("augment loop", () => {
  it("warns when AUGMENTS mode can't install", () => {
    const augmentLoop = { augmentsMode: true, autoPurchase: true, autoInstall: false, pending: 4 };
    expect(messages(base({ augmentLoop }))).toContain(
      "WARN: AUGMENTS mode, but autoInstall is off in /etc/faction.txt - the buy-and-install loop can't run (4 augmentation(s) pending)."
    );
  });

  it("is quiet outside AUGMENTS or with both switches on", () => {
    expect(checkStatus(base({ augmentLoop: { augmentsMode: false, autoPurchase: false, autoInstall: false, pending: 0 } }))).toEqual([]);
    expect(checkStatus(base({ augmentLoop: { augmentsMode: true, autoPurchase: true, autoInstall: true, pending: 0 } }))).toEqual([]);
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

  it("says when falling cash is going into stocks", () => {
    const spending = [{ category: "stock", perMin: 4.08e10 }];
    expect(messages(base({ rates: { hacking: 1e9, cash: -6.02e10, netWorth: 1e10 }, spending }))).toContain(
      "info: Cash is falling $60.2B/min (top spending: stock $40.8B/min), but net worth is rising $10.0B/min - cash is going into stocks."
    );
  });

  it("names the biggest spending when cash falls", () => {
    const spending = [{ category: "servers", perMin: 1.2e11 }, { category: "gang_expenses", perMin: 5.7e9 }];
    expect(messages(base({ rates: { hacking: 1e9, cash: -1.15e11 }, spending }))).toContain(
      "info: Cash is falling $115B/min (top spending: servers $120B/min, gang_expenses $5.7B/min) - spending exceeds income."
    );
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

  it("reads the per-minute batch summary", () => {
    const summary = summarizeScheduler(["[1:00:00 PM] [PID: 1] [INFO ] [Scheduler] [Scheduler] Batch summary (60s): 1700 batches across 24 target(s), top ecorp; 2 drift re-prep(s)."]);
    expect(summary).toMatchObject({ target: "ecorp", fired: 1700, batchesPerMin: 1700 });
  });

  it("finds the target from prep and not-hackable lines", () => {
    expect(summarizeScheduler(["[1:00:00 PM] [PID: 1] [DEBUG] [Scheduler] [Scheduler] Prep weaken on ecorp: security=1/1"]).target).toBe("ecorp");
    expect(summarizeScheduler(["[1:00:00 PM] [PID: 1] [WARN ] [Scheduler] [Scheduler] phantasy not hackable for hackFraction 0.05"]).target).toBe("phantasy");
  });
});
