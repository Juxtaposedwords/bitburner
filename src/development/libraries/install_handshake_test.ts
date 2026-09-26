import { describe, expect, it } from "vitest";
import { INSTALL_PENDING_MAX_AGE_SEC, isInstallPendingActive } from "development/libraries/install_handshake";

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
