import { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { computeWeights, prepDiscount, readWeightsFile, shouldRecompute, weightOf } from "hacking/target_selector";
import * as server_metadata_pb from "system/rpc/server_metadata";

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

describe("computeWeights with live rates", () => {
  const server = (hostname: string, maxMoney: number): server_metadata_pb.Metadata => ({ hostname, maxMoney, minSecurityLevel: 10 });

  it("prefers the rich server once its prep fits the horizon", () => {
    // ecorp prepped (no discount) vs foodnstuff: money wins.
    const rate = (host: string): number => (host === "ecorp" ? 0.6 : 1);
    expect(computeWeights([server("ecorp", 1.6e12), server("foodnstuff", 5e7)], rate).map((w) => w.hostname)).toEqual(["ecorp", "foodnstuff"]);
  });

  it("ranks a server whose prep is absurdly long below a ready one", () => {
    // Even an absurd prep (a week) only discounts: a rich server isn't ruled out forever.
    const rate = (host: string): number => (host === "ecorp" ? 0.6 * prepDiscount(7 * 24 * 3600_000, 30 * 60_000) : 1);
    expect(computeWeights([server("ecorp", 1.6e12), server("the-hub", 4.9e9)], rate).map((w) => w.hostname)).toEqual(["the-hub", "ecorp"]);
  });

  it("falls back to the static weight without a rate", () => {
    expect(computeWeights([server("a", 100)], () => undefined)).toEqual([{ hostname: "a", weight: weightOf(server("a", 100)) }]);
  });
});

describe("prepDiscount", () => {
  it("is 1 for no prep and falls smoothly, never reaching 0", () => {
    expect(prepDiscount(0, 30)).toBe(1);
    expect(prepDiscount(30, 30)).toBe(0.5);
    expect(prepDiscount(90, 30)).toBe(0.25);
    expect(prepDiscount(1e9, 30)).toBeGreaterThan(0);
  });

  it("keeps a $1.6T server needing a long prep far above a prepped $4.9B one", () => {
    expect(1.6e12 * 0.9 * prepDiscount(60, 30)).toBeGreaterThan(4.9e9 * prepDiscount(0, 30) * 10);
  });
});
