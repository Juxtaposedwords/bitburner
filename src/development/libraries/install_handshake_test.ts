import { describe, expect, it } from "vitest";
import { advanceSpendDown, INSTALL_PENDING_MAX_AGE_SEC, isInstallPendingActive, isSpendDownActive, spendDownSettled } from "development/libraries/install_handshake";

describe("isInstallPendingActive", () => {
  it("is inactive with no flag", () => {
    expect(isInstallPendingActive(undefined, 1000)).toBe(false);
  });

  it("is active while the heartbeat is fresh", () => {
    expect(isInstallPendingActive({ since: 900, heartbeat: 990 }, 1000)).toBe(true);
  });

  it("stops counting once the heartbeat goes stale, so a dead faction_daemon can't park the portfolio in cash forever", () => {
    const heartbeat = 1000;
    expect(isInstallPendingActive({ since: 0, heartbeat }, heartbeat + INSTALL_PENDING_MAX_AGE_SEC)).toBe(true);
    expect(isInstallPendingActive({ since: 0, heartbeat }, heartbeat + INSTALL_PENDING_MAX_AGE_SEC + 1)).toBe(false);
  });
});

describe("spend-down settling", () => {
  it("restarts the settle clock whenever cash drops", () => {
    let state = advanceSpendDown(undefined, 100, 0);
    state = advanceSpendDown(state, 60, 5000);
    expect(state.lastDropAt).toBe(5000);
    state = advanceSpendDown(state, 60, 10000);
    expect(state.lastDropAt).toBe(5000);
  });

  it("settles once cash hasn't dropped for the settle window", () => {
    const state = { since: 0, lastCash: 60, lastDropAt: 5000 };
    expect(spendDownSettled(state, 20000, 20000)).toBe(false);
    expect(spendDownSettled(state, 25000, 20000)).toBe(true);
  });

  it("counts cash rising (income) as nothing bought", () => {
    const state = advanceSpendDown({ since: 0, lastCash: 60, lastDropAt: 5000 }, 80, 9000);
    expect(state.lastDropAt).toBe(5000);
  });
});

describe("isSpendDownActive", () => {
  it("is only true in the spend-down phase with a live heartbeat", () => {
    expect(isSpendDownActive({ since: 0, heartbeat: 100, phase: "spendDown" }, 110)).toBe(true);
    expect(isSpendDownActive({ since: 0, heartbeat: 100 }, 110)).toBe(false);
    expect(isSpendDownActive({ since: 0, heartbeat: 100, phase: "spendDown" }, 100 + INSTALL_PENDING_MAX_AGE_SEC + 1)).toBe(false);
  });
});
