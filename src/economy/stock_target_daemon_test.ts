import { describe, expect, it } from "vitest";
import * as server_metadata_pb from "system/rpc/server_metadata";
import { computeStockTargetWeights } from "economy/stock_target_daemon";

const metadata = (hostname: string, overrides: Partial<server_metadata_pb.Metadata> = {}): server_metadata_pb.Metadata => ({
  hostname,
  ...overrides,
});

describe("computeStockTargetWeights", () => {
  it("includes a server whose organization is currently held long", () => {
    const server = metadata("ecorp-server", { organization: "ECorp" });
    const longPositions = new Map([["ECorp", 10_000]]);

    expect(computeStockTargetWeights([server], longPositions)).toEqual([{ hostname: "ecorp-server", weight: 10_000 }]);
  });

  it("excludes a server whose organization has no stock, or has one we don't hold long", () => {
    const noOrg = metadata("n00dles");
    const notHeld = metadata("megacorp-server", { organization: "MegaCorp" });
    const longPositions = new Map([["ECorp", 10_000]]);

    expect(computeStockTargetWeights([noOrg, notHeld], longPositions)).toEqual([]);
  });

  it("ranks by cost basis descending - defends the biggest position first", () => {
    const small = metadata("small-server", { organization: "Small" });
    const big = metadata("big-server", { organization: "Big" });
    const longPositions = new Map([
      ["Small", 1_000],
      ["Big", 1_000_000],
    ]);

    expect(computeStockTargetWeights([small, big], longPositions)).toEqual([
      { hostname: "big-server", weight: 1_000_000 },
      { hostname: "small-server", weight: 1_000 },
    ]);
  });

  it("returns an empty array when nothing is held long", () => {
    expect(computeStockTargetWeights([metadata("a", { organization: "ECorp" })], new Map())).toEqual([]);
  });

  it("returns an empty array for an empty server list", () => {
    expect(computeStockTargetWeights([], new Map([["ECorp", 10_000]]))).toEqual([]);
  });
});
