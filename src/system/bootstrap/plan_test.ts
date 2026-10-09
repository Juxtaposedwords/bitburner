import { describe, expect, it } from "vitest";
import { fullSystemFits, playerActivity, hashIncomePerSec, pickBootstrapTarget, pickHacknetPurchase, requiredHomeRam, shouldHandOffToShopper, TOR_COST, workerThreads } from "system/bootstrap/plan";

describe("requiredHomeRam", () => {
  it("sums the core scripts' RAM plus the margin", () => {
    expect(requiredHomeRam([10, 5, 2], 16)).toBe(33);
  });

  it("is unknowable (Infinity) if a script is missing", () => {
    expect(requiredHomeRam([10, 0, 2], 16)).toBe(Infinity);
  });
});

describe("pickBootstrapTarget", () => {
  const servers = [
    { host: "n00dles", maxMoney: 1.75e6, requiredHackingLevel: 1, hasRoot: true },
    { host: "joesguns", maxMoney: 62.5e6, requiredHackingLevel: 10, hasRoot: true },
    { host: "phantasy", maxMoney: 600e6, requiredHackingLevel: 100, hasRoot: true },
    { host: "unrooted", maxMoney: 1e12, requiredHackingLevel: 1, hasRoot: false },
  ];

  it("picks the richest rooted server within half the hacking level", () => {
    expect(pickBootstrapTarget(servers, 43)).toBe("joesguns");
    expect(pickBootstrapTarget(servers, 200)).toBe("phantasy");
  });

  it("allows the full level while hacking is very low", () => {
    expect(pickBootstrapTarget(servers, 5)).toBe("n00dles");
  });

  it("is undefined with nothing hackable", () => {
    expect(pickBootstrapTarget([servers[3]], 43)).toBeUndefined();
  });
});

describe("workerThreads", () => {
  it("counts whole threads that fit", () => {
    expect(workerThreads(10, 2.4)).toBe(4);
    expect(workerThreads(-1, 2.4)).toBe(0);
    expect(workerThreads(10, 0)).toBe(0);
  });
});

describe("shouldHandOffToShopper", () => {
  it("hands off once TOR is affordable and not owned", () => {
    expect(shouldHandOffToShopper(TOR_COST, false, [], Infinity)).toBe(true);
    expect(shouldHandOffToShopper(TOR_COST - 1, false, [], Infinity)).toBe(false);
  });

  it("hands off for an affordable unowned port opener", () => {
    expect(shouldHandOffToShopper(600e3, true, [0, 500e3, 1.5e6], Infinity)).toBe(true);
  });

  it("ignores owned programs (cost 0) and missing TOR (-1)", () => {
    expect(shouldHandOffToShopper(1e3, true, [0, -1], Infinity)).toBe(false);
  });

  it("hands off once the next home RAM upgrade is affordable", () => {
    expect(shouldHandOffToShopper(2e6, true, [0], 1.5e6)).toBe(true);
    expect(shouldHandOffToShopper(1e6, true, [0], 1.5e6)).toBe(false);
  });
});

describe("pickBootstrapTarget keeps its target", () => {
  const servers = [
    { host: "sigma-cosmetics", maxMoney: 57.5e6, requiredHackingLevel: 5, hasRoot: true },
    { host: "joesguns", maxMoney: 62.5e6, requiredHackingLevel: 10, hasRoot: true },
    { host: "phantasy", maxMoney: 600e6, requiredHackingLevel: 100, hasRoot: true },
  ];

  it("over one barely richer (a switch restarts every worker)", () => {
    expect(pickBootstrapTarget(servers, 24, "sigma-cosmetics")).toBe("sigma-cosmetics");
  });

  it("but switches for one worth twice as much, or when it's no longer allowed", () => {
    expect(pickBootstrapTarget(servers, 200, "sigma-cosmetics")).toBe("phantasy");
    expect(pickBootstrapTarget(servers, 24, "gone")).toBe("joesguns");
  });
});

describe("pickHacknetPurchase", () => {
  const options = [
    { kind: "server" as const, index: -1, cost: 1e6 },
    { kind: "level" as const, index: 0, cost: 2e4 },
    { kind: "ram" as const, index: 0, cost: 3e5 },
    { kind: "core" as const, index: 0, cost: Infinity },
  ];

  it("buys the cheapest improvement within the share of cash", () => {
    expect(pickHacknetPurchase(options, 1e5, 0.5)).toMatchObject({ kind: "level", index: 0 });
  });

  it("buys nothing it can't afford within the share (cash keeps building)", () => {
    expect(pickHacknetPurchase(options, 3e4, 0.5)).toBeUndefined();
  });
});

describe("fullSystemFits", () => {
  const stack = [29.7, 31.1, 16.6, 25.3, 6.75];
  it("waits for room for the faction stack when no hacked server can take a service", () => {
    expect(fullSystemFits(128, 56, stack, 0)).toBe(false);
    expect(fullSystemFits(256, 56, stack, 0)).toBe(true);
  });
  it("needs only the core and the planner once services can go on hacked servers", () => {
    expect(fullSystemFits(60, 56, stack, 4)).toBe(false);
    expect(fullSystemFits(128, 56, stack, 4)).toBe(true);
  });
});

describe("hashIncomePerSec", () => {
  it("is the hash rate at Sell for Money's payout", () => {
    expect(hashIncomePerSec(0.001, 4)).toBe(250);
    expect(hashIncomePerSec(1, 4)).toBe(250_000);
    expect(hashIncomePerSec(1, 0)).toBe(0);
  });
});

describe("playerActivity", () => {
  it("commits a crime for money while the hacknet earns less than that (BN9)", () => {
    expect(playerActivity(true, 250, undefined)).toBe("crime");
    expect(playerActivity(true, 250, "CRIME")).toBe("leave");
    expect(playerActivity(true, 250, "CLASS")).toBe("crime");
  });
  it("otherwise studies in idle time or after its own crime, never over other work", () => {
    expect(playerActivity(true, 5000, "CRIME")).toBe("study");
    expect(playerActivity(false, 0, undefined)).toBe("study");
    expect(playerActivity(false, 0, "FACTION")).toBe("leave");
  });
});
