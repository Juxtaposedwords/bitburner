import { NS, Server } from "@ns";
import { describe, expect, it } from "vitest";
import { classifyServerKind, foldNetwork, toServerMetadata } from "development/metadata/crawl_servers";
import { RootStatus, ServerKind } from "development/metadata/server_metadata";

const fakeServer = (overrides: Partial<Server> = {}): Server => overrides as Server;

describe("toServerMetadata", () => {
  it("maps a fully-populated server", () => {
    const server = fakeServer({
      organizationName: "ECorp",
      ip: "1.2.3.4",
      hackDifficulty: 50,
      minDifficulty: 10,
      serverGrowth: 3,
      hasAdminRights: true,
      backdoorInstalled: true,
      purchasedByPlayer: true,
      maxRam: 64,
      ramUsed: 16,
      cpuCores: 4,
      requiredHackingSkill: 200,
      numOpenPortsRequired: 3,
      sshPortOpen: true,
      ftpPortOpen: true,
      smtpPortOpen: false,
      httpPortOpen: true,
      sqlPortOpen: false,
      moneyAvailable: 5e8,
      moneyMax: 1e9,
    });

    expect(toServerMetadata("ecorp", "home -> ecorp", server)).toEqual({
      hostname: "ecorp",
      organization: "ECorp",
      ip: "1.2.3.4",
      pathFromHome: "home -> ecorp",
      securityLevel: 50,
      minSecurityLevel: 10,
      growthMultiplier: 3,
      rootStatus: RootStatus.ROOTED,
      backdoorInstalled: true,
      kind: ServerKind.PURCHASED,
      maxRam: 64,
      ramAvailable: 48,
      cpuCores: 4,
      hacking: {
        requirements: { level: 200, ports: 3 },
        ports: { ssh: true, ftp: true, smtp: false, http: true, sql: false },
      },
      moneyAvailable: 5e8,
      maxMoney: 1e9,
    });
  });

  it.each([
    { field: "organization" as const, expected: "" },
    { field: "ip" as const, expected: "" },
    { field: "securityLevel" as const, expected: 0 },
    { field: "minSecurityLevel" as const, expected: 0 },
    { field: "growthMultiplier" as const, expected: 1 },
    { field: "rootStatus" as const, expected: RootStatus.UNROOTABLE },
    { field: "backdoorInstalled" as const, expected: false },
    { field: "kind" as const, expected: ServerKind.NPC },
    { field: "maxRam" as const, expected: 0 },
    { field: "cpuCores" as const, expected: 1 },
  ])("defaults $field to $expected when the server doesn't report it", ({ field, expected }) => {
    const result = toServerMetadata("n00dles", "home", fakeServer());

    expect(result[field]).toBe(expected);
  });

  it("computes ramAvailable from maxRam minus ramUsed", () => {
    const result = toServerMetadata("n00dles", "home", fakeServer({ maxRam: 64, ramUsed: 16 }));

    expect(result.ramAvailable).toBe(48);
  });

  it("defaults all hacking port flags to false, leaving unreported requirements undefined", () => {
    const result = toServerMetadata("n00dles", "home", fakeServer());

    expect(result.hacking).toEqual({
      requirements: { level: undefined, ports: undefined },
      ports: { ssh: false, ftp: false, smtp: false, http: false, sql: false },
    });
  });
});

describe("classifyServerKind", () => {
  it("classifies \"home\" as HOME regardless of purchasedByPlayer", () => {
    expect(classifyServerKind("home", false)).toBe(ServerKind.HOME);
    expect(classifyServerKind("home", true)).toBe(ServerKind.HOME);
  });

  it("classifies a hacknet-server-<N> hostname as HACKNET even though ns reports it as purchasedByPlayer", () => {
    expect(classifyServerKind("hacknet-server-0", true)).toBe(ServerKind.HACKNET);
    expect(classifyServerKind("hacknet-server-12", true)).toBe(ServerKind.HACKNET);
  });

  it("classifies any other purchasedByPlayer host as PURCHASED", () => {
    expect(classifyServerKind("pserv-0", true)).toBe(ServerKind.PURCHASED);
  });

  it("classifies a non-purchased, non-special host as NPC", () => {
    expect(classifyServerKind("n00dles", false)).toBe(ServerKind.NPC);
  });

  it("does not misclassify a hostname that merely contains \"hacknet-server\" as a substring", () => {
    expect(classifyServerKind("not-hacknet-server-0", true)).toBe(ServerKind.PURCHASED);
    expect(classifyServerKind("hacknet-server-abc", true)).toBe(ServerKind.PURCHASED);
  });
});

describe("foldNetwork", () => {
  // home <-> n00dles (cycle back to an already-visited host), home -> foodnstuff (leaf).
  const network: Record<string, string[]> = {
    home: ["n00dles", "foodnstuff"],
    n00dles: ["home"],
    foodnstuff: [],
  };
  const ns = { scan: (host: string) => network[host] ?? [] } as unknown as NS;

  it("visits every reachable host exactly once via its scanned path, skipping cycles", async () => {
    const calls: { host: string; path: string }[] = [];
    const processFn = async (host: string, path: string) => {
      calls.push({ host, path });
      return true;
    };

    await foldNetwork(ns, "home", "home", processFn);

    expect(calls).toEqual([
      { host: "home", path: "home" },
      { host: "n00dles", path: "home -> n00dles" },
      { host: "foodnstuff", path: "home -> foodnstuff" },
    ]);
  });

  it("tallies success and dropped counts from processFn's result", async () => {
    const processFn = async (host: string) => host !== "foodnstuff";

    const { success, dropped, visited } = await foldNetwork(ns, "home", "home", processFn);

    expect(visited).toEqual(new Set(["home", "n00dles", "foodnstuff"]));
    expect(success).toBe(2);
    expect(dropped).toBe(1);
  });
});
