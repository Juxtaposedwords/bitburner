import { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { computeWeights, readWeightsFile, shouldRecompute, weightOf } from "development/metadata/target_selector";
import * as server_metadata_pb from "development/metadata/server_metadata";

const metadata = (hostname: string, overrides: Partial<server_metadata_pb.Metadata> = {}): server_metadata_pb.Metadata => ({
  hostname,
  ...overrides,
});

describe("weightOf", () => {
  it("rewards more money and penalizes higher minimum security", () => {
    const richer = weightOf(metadata("a", { maxMoney: 2_000_000, minSecurityLevel: 10 }));
    const poorer = weightOf(metadata("b", { maxMoney: 1_000_000, minSecurityLevel: 10 }));
    const harder = weightOf(metadata("c", { maxMoney: 1_000_000, minSecurityLevel: 50 }));

    expect(richer).toBeGreaterThan(poorer);
    expect(poorer).toBeGreaterThan(harder);
  });

  it("doesn't divide by zero when minSecurityLevel is unset or zero", () => {
    expect(weightOf(metadata("a", { maxMoney: 1_000_000 }))).toBe(1_000_000);
    expect(weightOf(metadata("a", { maxMoney: 1_000_000, minSecurityLevel: 0 }))).toBe(1_000_000);
  });
});

describe("computeWeights", () => {
  it("sorts servers best-first", () => {
    const low = metadata("low", { maxMoney: 100, minSecurityLevel: 10 });
    const high = metadata("high", { maxMoney: 10_000, minSecurityLevel: 10 });

    expect(computeWeights([low, high])).toEqual([
      { hostname: "high", weight: weightOf(high) },
      { hostname: "low", weight: weightOf(low) },
    ]);
  });

  it("skips servers with no hostname", () => {
    expect(computeWeights([{} as server_metadata_pb.Metadata])).toEqual([]);
  });
});

describe("shouldRecompute", () => {
  it.each([
    { name: "no stored level yet", stored: undefined, current: 50, expected: true },
    { name: "stored level differs from current", stored: 40, current: 50, expected: true },
    { name: "stored level matches current", stored: 50, current: 50, expected: false },
  ])("$name", ({ stored, current, expected }) => {
    expect(shouldRecompute(stored, current)).toBe(expected);
  });
});

describe("readWeightsFile", () => {
  const fakeNs = (fileContent?: string): NS =>
    ({
      read: (() => fileContent ?? "") as NS["read"],
    }) as NS;

  it("returns undefined when no file exists yet", () => {
    expect(readWeightsFile(fakeNs(), "/var/target_selector/weights.txt")).toBeUndefined();
  });

  it("returns undefined for corrupt JSON instead of throwing", () => {
    expect(readWeightsFile(fakeNs("not json"), "/var/target_selector/weights.txt")).toBeUndefined();
  });

  it("parses a previously-written file", () => {
    const file = { hackingLevel: 50, computedAt: 123, weights: [{ hostname: "n00dles", weight: 10 }] };

    expect(readWeightsFile(fakeNs(JSON.stringify(file)), "/var/target_selector/weights.txt")).toEqual(file);
  });
});
