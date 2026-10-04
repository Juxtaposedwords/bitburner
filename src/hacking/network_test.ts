import { describe, expect, it } from "vitest";
import { backdoorTargets, classifyKind, NetworkFile, NetworkServer } from "hacking/network";

const server = (host: string, overrides: Partial<NetworkServer> = {}): NetworkServer => ({
  host,
  path: [host],
  kind: "npc",
  rooted: true,
  backdoor: false,
  organization: "",
  maxRam: 0,
  maxMoney: 1,
  requiredLevel: 10,
  portsRequired: 0,
  ...overrides,
});
const file = (servers: NetworkServer[], hackingLevel = 100): NetworkFile => ({ servers, hackingLevel, writtenAt: 0 });

describe("classifyKind", () => {
  it("tells home, Hacknet, purchased and NPC servers apart", () => {
    expect(classifyKind("home", false)).toBe("home");
    expect(classifyKind("hacknet-server-3", true)).toBe("hacknet");
    expect(classifyKind("pserv-0", true)).toBe("purchased");
    expect(classifyKind("ecorp", false)).toBe("npc");
  });
});

describe("backdoorTargets", () => {
  it("keeps rooted NPC servers within hacking level that aren't backdoored", () => {
    expect(backdoorTargets(file([server("a")])).map((s) => s.host)).toEqual(["a"]);
  });

  it("skips done, unrooted, out-of-level and non-NPC servers", () => {
    const servers = [
      server("done", { backdoor: true }),
      server("locked", { rooted: false }),
      server("hard", { requiredLevel: 500 }),
      server("pserv-0", { kind: "purchased" }),
    ];
    expect(backdoorTargets(file(servers))).toEqual([]);
  });

  it("never backdoors w0r1d_d43m0n - that would end the BitNode", () => {
    expect(backdoorTargets(file([server("w0r1d_d43m0n"), server("a")])).map((s) => s.host)).toEqual(["a"]);
  });
});
