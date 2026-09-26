import { describe, expect, it } from "vitest";
import { bitNodeMultipliersAvailable, buildBitNodeInfo, parseBitNodeInfo } from "development/libraries/bitnode_info";

describe("bitNodeMultipliersAvailable", () => {
  it("needs Source-File 5 or BitNode 5", () => {
    expect(bitNodeMultipliersAvailable(9, new Map([[5, 3]]))).toBe(true);
    expect(bitNodeMultipliersAvailable(5, new Map())).toBe(true);
    expect(bitNodeMultipliersAvailable(9, new Map([[4, 3]]))).toBe(false);
  });
});

describe("parseBitNodeInfo", () => {
  it("round-trips what buildBitNodeInfo writes", () => {
    const info = buildBitNodeInfo(9, 123, new Map([[5, 3], [-1, 4]]), { HackingLevelMultiplier: 0.5 }, 456);
    expect(parseBitNodeInfo(JSON.stringify(info))).toEqual({
      v: 1,
      node: 9,
      lastNodeReset: 123,
      sourceFiles: { "5": 3, "-1": 4 },
      multipliers: { HackingLevelMultiplier: 0.5 },
      writtenAt: 456,
    });
  });

  it("rejects empty, corrupt, and other-version contents", () => {
    expect(parseBitNodeInfo("")).toBeUndefined();
    expect(parseBitNodeInfo("{bad")).toBeUndefined();
    expect(parseBitNodeInfo(JSON.stringify({ v: 2, node: 9 }))).toBeUndefined();
  });
});
