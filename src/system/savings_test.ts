import { describe, expect, it } from "vitest";
import { effectiveReserve, parseSavings, shouldLiquidateForSavings } from "system/savings";

describe("parseSavings", () => {
  const fresh = JSON.stringify({ amount: 25e12, reason: "QLink", writtenAt: 1000 });

  it("returns a fresh target", () => {
    expect(parseSavings(fresh, 2000)).toEqual({ amount: 25e12, reason: "QLink", writtenAt: 1000 });
  });

  it("ignores a stale, empty, zero, or corrupt target", () => {
    expect(parseSavings(fresh, 1000 + 60_001)).toBeUndefined();
    expect(parseSavings("", 2000)).toBeUndefined();
    expect(parseSavings(JSON.stringify({ amount: 0, reason: "", writtenAt: 1000 }), 2000)).toBeUndefined();
    expect(parseSavings("{bad", 2000)).toBeUndefined();
  });
});

describe("effectiveReserve", () => {
  it("takes the higher of the daemon's reserve and the savings target", () => {
    expect(effectiveReserve(1e9, { amount: 25e12, reason: "", writtenAt: 0 })).toBe(25e12);
    expect(effectiveReserve(1e9, undefined)).toBe(1e9);
  });
});

describe("shouldLiquidateForSavings", () => {
  const savings = { amount: 100, reason: "", writtenAt: 0 };

  it("sells once cash plus stock covers a target cash alone doesn't", () => {
    expect(shouldLiquidateForSavings(savings, 60, 50)).toBe(true);
  });

  it("holds while stock can't close the gap, or cash already covers it", () => {
    expect(shouldLiquidateForSavings(savings, 30, 50)).toBe(false);
    expect(shouldLiquidateForSavings(savings, 120, 50)).toBe(false);
    expect(shouldLiquidateForSavings(undefined, 30, 500)).toBe(false);
  });
});
