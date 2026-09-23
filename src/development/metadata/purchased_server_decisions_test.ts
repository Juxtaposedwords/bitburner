import { describe, expect, it } from "vitest";
import { decideServerInvestment } from "development/metadata/purchased_server_decisions";

describe("decideServerInvestment", () => {
  it("buys a new server sized off startingRamGb when nothing is owned yet", () => {
    const { decision } = decideServerInvestment(1000, 0, 1, 1_048_576, false, 8, [], (ram) => (ram === 8 ? 100 : Infinity), () => Infinity);

    expect(decision).toEqual({ kind: "buyNew", ram: 8 });
  });

  it("sizes a new purchase off the smallest currently-owned server, not startingRamGb", () => {
    const owned = [
      { host: "pserv-0", ram: 32 },
      { host: "pserv-1", ram: 16 },
    ];

    const { decision } = decideServerInvestment(1000, 0, 1, 1_048_576, false, 8, owned, (ram) => (ram === 16 ? 100 : Infinity), () => Infinity);

    expect(decision).toEqual({ kind: "buyNew", ram: 16 });
  });

  it("upgrades the weakest owned server (doubling its RAM) when that's cheaper than buying new", () => {
    const owned = [
      { host: "pserv-0", ram: 32 },
      { host: "pserv-1", ram: 16 },
    ];

    const { decision } = decideServerInvestment(
      1000,
      0,
      1,
      1_048_576,
      false,
      8,
      owned,
      () => 500,
      (host, ram) => (host === "pserv-1" && ram === 32 ? 50 : Infinity)
    );

    expect(decision).toEqual({ kind: "upgrade", host: "pserv-1", ram: 32 });
  });

  it("clamps the upgrade target to ramLimit rather than doubling past it", () => {
    const owned = [{ host: "pserv-0", ram: 1_048_576 * 0.75 }];

    const { decision } = decideServerInvestment(
      1_000_000,
      0,
      1,
      1_048_576,
      true,
      8,
      owned,
      () => Infinity,
      (host, ram) => (ram === 1_048_576 ? 10 : Infinity)
    );

    expect(decision).toEqual({ kind: "upgrade", host: "pserv-0", ram: 1_048_576 });
  });

  it("never proposes buying once atServerLimit is true", () => {
    const owned = [{ host: "pserv-0", ram: 16 }];

    const { decision } = decideServerInvestment(1000, 0, 1, 1_048_576, true, 8, owned, () => 1, () => 500);

    expect(decision).toEqual({ kind: "upgrade", host: "pserv-0", ram: 32 });
  });

  it("never proposes upgrading a server already at ramLimit", () => {
    const owned = [{ host: "pserv-0", ram: 1_048_576 }];

    const { decision } = decideServerInvestment(1000, 0, 1, 1_048_576, true, 8, owned, () => 1, () => 1);

    expect(decision).toEqual({ kind: "none" });
  });

  it("returns none when nothing is affordable", () => {
    const { decision } = decideServerInvestment(10, 0, 1, 1_048_576, false, 8, [], () => 1000, () => 1000);

    expect(decision).toEqual({ kind: "none" });
  });

  it("respects reserveMoney as an absolute floor never spent below", () => {
    const { decision } = decideServerInvestment(1000, 950, 1, 1_048_576, false, 8, [], () => 100, () => Infinity);

    expect(decision).toEqual({ kind: "none" });
  });

  it("respects maxSpendFraction as a relative throttle even with no reserve", () => {
    const { decision } = decideServerInvestment(1000, 0, 0.05, 1_048_576, false, 8, [], () => 100, () => Infinity);

    expect(decision).toEqual({ kind: "none" });
  });

  it("uses the tighter of reserveMoney and maxSpendFraction", () => {
    const { decision } = decideServerInvestment(1000, 900, 0.5, 1_048_576, false, 8, [], () => 150, () => Infinity);

    expect(decision).toEqual({ kind: "none" });
  });

  it("treats a negative upgrade cost (invalid target, per ns.cloud.getServerUpgradeCost's -1 convention) as unaffordable", () => {
    const owned = [{ host: "pserv-0", ram: 16 }];

    const { decision } = decideServerInvestment(1_000_000, 0, 1, 1_048_576, true, 8, owned, () => Infinity, () => -1);

    expect(decision).toEqual({ kind: "none" });
  });

  describe("diagnostic fields (for logging why a tick did nothing)", () => {
    it("reports the computed budget alongside the decision", () => {
      const { budget } = decideServerInvestment(1000, 200, 0.5, 1_048_576, false, 8, [], () => Infinity, () => Infinity);

      expect(budget).toBe(500); // min(1000-200, 1000*0.5) = min(800, 500) = 500
    });

    it("reports buyNewCandidate's cost even when it isn't affordable/chosen", () => {
      const { buyNewCandidate, decision } = decideServerInvestment(10, 0, 1, 1_048_576, false, 8, [], () => 999_999, () => Infinity);

      expect(buyNewCandidate).toEqual({ ram: 8, cost: 999_999 });
      expect(decision).toEqual({ kind: "none" });
    });

    it("omits buyNewCandidate entirely when atServerLimit skipped it", () => {
      const owned = [{ host: "pserv-0", ram: 16 }];

      const { buyNewCandidate } = decideServerInvestment(1_000_000, 0, 1, 1_048_576, true, 8, owned, () => 1, () => 500);

      expect(buyNewCandidate).toBeUndefined();
    });

    it("reports upgradeCandidate's cost even when it isn't affordable/chosen, and omits it when there's nothing owned", () => {
      const owned = [{ host: "pserv-0", ram: 16 }];

      const withOwned = decideServerInvestment(10, 0, 1, 1_048_576, true, 8, owned, () => Infinity, () => 777_777);
      expect(withOwned.upgradeCandidate).toEqual({ host: "pserv-0", ram: 32, cost: 777_777 });

      const withNoneOwned = decideServerInvestment(10, 0, 1, 1_048_576, false, 8, [], () => Infinity, () => 777_777);
      expect(withNoneOwned.upgradeCandidate).toBeUndefined();
    });
  });
});
