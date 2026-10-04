import { describe, expect, it } from "vitest";
import { shouldUpgradeHomeRam } from "hacking/program_shopper";

describe("shouldUpgradeHomeRam", () => {
  it("buys when the upgrade fits within the spend fraction", () => {
    expect(shouldUpgradeHomeRam(40, 100, 0, 0.5)).toBe(true);
  });

  it("waits when it would take more than the spend fraction", () => {
    expect(shouldUpgradeHomeRam(60, 100, 0, 0.5)).toBe(false);
  });

  it("never dips into the reserve or savings target", () => {
    expect(shouldUpgradeHomeRam(40, 100, 80, 0.5)).toBe(false);
  });

  it("stops at the game's maximum (infinite cost)", () => {
    expect(shouldUpgradeHomeRam(Infinity, 1e30, 0, 0.5)).toBe(false);
  });
});
