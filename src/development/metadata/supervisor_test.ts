import { describe, expect, it } from "vitest";
import { computeHackStatus, computeRootStatus, createHandlers, createPlayerHandlers, createSupervisorState, hasMoney, isEligible, isRootable } from "development/metadata/supervisor";
import { Logger } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import * as server_metadata_pb from "development/metadata/server_metadata";

const metadata = (hostname: string, overrides: Partial<server_metadata_pb.Metadata> = {}): server_metadata_pb.Metadata => ({
  hostname,
  ...overrides,
});

// Handlers are RAM-only (see supervisor.ts), so no NS is needed to test them.
const noopLog: Logger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
};

describe("Supervisor RPC handlers", () => {
  describe("UpdateMetadata", () => {
    it.each([
      { name: "a new hostname", initialHostnames: new Set<string>(), expectedListDirty: true },
      { name: "an already-known hostname", initialHostnames: new Set(["n00dles"]), expectedListDirty: false },
    ])("stores the server and queues a flush, marking the list dirty only for $name", ({ initialHostnames, expectedListDirty }) => {
      const state = createSupervisorState(new Map(), initialHostnames);
      const handlers = createHandlers(noopLog, state);

      const res = handlers.UpdateMetadata({ server: metadata("n00dles", { maxRam: 8 }) });

      expect(res).toEqual({});
      expect(state.networkState.get("n00dles")).toEqual(metadata("n00dles", { maxRam: 8 }));
      expect(state.pendingWrites.get("n00dles")).toEqual(metadata("n00dles", { maxRam: 8 }));
      expect(state.knownHostnames.has("n00dles")).toBe(true);
      expect(state.listDirty).toBe(expectedListDirty);
      expect(state.processedSinceFlush).toBe(1);
    });
  });

  describe("PatchMetadata", () => {
    it.each([
      {
        name: "overwrites a defined field",
        base: { maxRam: 8, rootStatus: server_metadata_pb.RootStatus.UNROOTABLE },
        patch: { rootStatus: server_metadata_pb.RootStatus.ROOTED },
        expected: { maxRam: 8, rootStatus: server_metadata_pb.RootStatus.ROOTED },
      },
      {
        name: "ignores an undefined field",
        base: { maxRam: 8 },
        patch: { maxRam: undefined },
        expected: { maxRam: 8 },
      },
    ])("$name", async ({ base, patch, expected }) => {
      const state = createSupervisorState(new Map([["n00dles", metadata("n00dles", base)]]));
      const handlers = createHandlers(noopLog, state);

      const res = await handlers.PatchMetadata({ server: metadata("n00dles", patch) });

      expect(res).toEqual({});
      expect(state.networkState.get("n00dles")).toEqual(metadata("n00dles", expected));
      expect(state.pendingWrites.has("n00dles")).toBe(true);
    });

    it("throws NOT_FOUND for an unknown hostname without touching state", async () => {
      const state = createSupervisorState();
      const handlers = createHandlers(noopLog, state);

      await expect(handlers.PatchMetadata({ server: metadata("unknown-host") })).rejects.toMatchObject({
        status: Codes.NOT_FOUND,
      });
      expect(state.pendingWrites.size).toBe(0);
    });
  });

  describe("ListServers", () => {
    it("returns every currently-known server, with rootStatus/hackStatus refined live", async () => {
      const state = createSupervisorState(
        new Map([
          ["n00dles", metadata("n00dles", { maxRam: 8 })],
          ["foodnstuff", metadata("foodnstuff", { maxRam: 16 })],
        ])
      );
      const handlers = createHandlers(noopLog, state);

      const res = await handlers.ListServers({});

      expect(res.servers).toEqual([
        metadata("n00dles", { maxRam: 8, rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, hackStatus: server_metadata_pb.HackStatus.UNHACKABLE }),
        metadata("foodnstuff", { maxRam: 16, rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, hackStatus: server_metadata_pb.HackStatus.UNHACKABLE }),
      ]);
    });

    it("returns an empty list when nothing is known yet", () => {
      const handlers = createHandlers(noopLog, createSupervisorState());

      expect(handlers.ListServers({})).toEqual({ servers: [] });
    });

    it("filters to only eligible servers when eligibleOnly is set", async () => {
      const eligible = metadata("n00dles", { rootStatus: server_metadata_pb.RootStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 5 } } });
      const notRooted = metadata("foodnstuff", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, maxMoney: 1000 });
      const levelTooHigh = metadata("joesguns", { rootStatus: server_metadata_pb.RootStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 500 } } });

      const state = createSupervisorState(
        new Map([
          ["n00dles", eligible],
          ["foodnstuff", notRooted],
          ["joesguns", levelTooHigh],
        ]),
        new Set(),
        50
      );
      const handlers = createHandlers(noopLog, state);

      const res = await handlers.ListServers({ eligibleOnly: true });

      expect(res.servers).toEqual([{ ...eligible, rootStatus: server_metadata_pb.RootStatus.ROOTED, hackStatus: server_metadata_pb.HackStatus.HACKABLE }]);
    });
  });

  describe("hasMoney", () => {
    it.each([
      { name: "rooted with money", overrides: {}, expected: true },
      { name: "not rooted", overrides: { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE }, expected: false },
      { name: "rooted but nothing to steal", overrides: { maxMoney: 0 }, expected: false },
    ])("$name", ({ overrides, expected }) => {
      const server = metadata("n00dles", { rootStatus: server_metadata_pb.RootStatus.ROOTED, maxMoney: 1000, ...overrides });
      expect(hasMoney(server)).toBe(expected);
    });
  });

  describe("isEligible", () => {
    const base = metadata("n00dles", { rootStatus: server_metadata_pb.RootStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 50 } } });

    it.each([
      { name: "rooted, has money, and within reach", overrides: {}, hackingLevel: 100, expected: true },
      { name: "not rooted", overrides: { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE }, hackingLevel: 100, expected: false },
      { name: "no money to steal", overrides: { maxMoney: 0 }, hackingLevel: 100, expected: false },
      { name: "hacking level requirement not yet met", overrides: {}, hackingLevel: 10, expected: false },
      { name: "unknown hacking requirement fails closed", overrides: { hacking: undefined }, hackingLevel: 100, expected: false },
    ])("$name", ({ overrides, hackingLevel, expected }) => {
      expect(isEligible({ ...base, ...overrides }, hackingLevel)).toBe(expected);
    });
  });

  describe("isRootable", () => {
    const base = metadata("n00dles", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, hacking: { requirements: { ports: 2 } } });

    it.each([
      { name: "enough port-openers owned", overrides: {}, portOpenersOwned: 2, expected: true },
      { name: "not enough port-openers owned", overrides: {}, portOpenersOwned: 1, expected: false },
      { name: "already rooted", overrides: { rootStatus: server_metadata_pb.RootStatus.ROOTED }, portOpenersOwned: 5, expected: false },
      { name: "unknown port requirement fails closed", overrides: { hacking: undefined }, portOpenersOwned: 5, expected: false },
    ])("$name", ({ overrides, portOpenersOwned, expected }) => {
      expect(isRootable({ ...base, ...overrides }, portOpenersOwned)).toBe(expected);
    });
  });

  describe("computeRootStatus", () => {
    it.each([
      { name: "not enough ports open", server: metadata("a", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, hacking: { requirements: { ports: 2 } } }), portOpenersOwned: 0, expected: server_metadata_pb.RootStatus.UNROOTABLE },
      { name: "enough ports open", server: metadata("a", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, hacking: { requirements: { ports: 2 } } }), portOpenersOwned: 2, expected: server_metadata_pb.RootStatus.ROOTABLE },
      { name: "already rooted stays rooted regardless of ports", server: metadata("a", { rootStatus: server_metadata_pb.RootStatus.ROOTED }), portOpenersOwned: 0, expected: server_metadata_pb.RootStatus.ROOTED },
    ])("$name", ({ server, portOpenersOwned, expected }) => {
      expect(computeRootStatus(server, portOpenersOwned)).toBe(expected);
    });
  });

  describe("computeHackStatus", () => {
    it.each([
      { name: "hacking level not yet met", server: metadata("a", { hacking: { requirements: { level: 50 } } }), hackingLevel: 10, expected: server_metadata_pb.HackStatus.UNHACKABLE },
      { name: "hacking level met", server: metadata("a", { hacking: { requirements: { level: 50 } } }), hackingLevel: 100, expected: server_metadata_pb.HackStatus.HACKABLE },
      { name: "unrooted server is still a valid comparison — independent of root status", server: metadata("a", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE, hacking: { requirements: { level: 50 } } }), hackingLevel: 100, expected: server_metadata_pb.HackStatus.HACKABLE },
      { name: "unknown hacking requirement fails closed", server: metadata("a", { hacking: undefined }), hackingLevel: 100, expected: server_metadata_pb.HackStatus.UNHACKABLE },
    ])("$name", ({ server, hackingLevel, expected }) => {
      expect(computeHackStatus(server, hackingLevel)).toBe(expected);
    });
  });

  describe("hostname validation", () => {
    it.each([{ method: "UpdateMetadata" as const }, { method: "PatchMetadata" as const }])(
      "$method throws when the request has no hostname",
      async ({ method }) => {
        const handlers = createHandlers(noopLog, createSupervisorState());

        // Normalizes UpdateMetadata's synchronous throw and PatchMetadata's
        // rejection into the same assertable shape.
        await expect(
          Promise.resolve().then(() => handlers[method]({ server: {} as server_metadata_pb.Metadata }))
        ).rejects.toMatchObject({
          status: Codes.INVALID_ARGUMENT,
          message: expect.stringContaining("hostname is required"),
        });
      }
    );
  });
});

describe("Player RPC handlers", () => {
  describe("GetPlayerMetadata", () => {
    it("returns the current hackingLevel/portOpenersOwned from state", () => {
      const state = createSupervisorState(new Map(), new Set(), 42, 3);
      const handlers = createPlayerHandlers(state);

      expect(handlers.GetPlayerMetadata({})).toEqual({
        player: expect.objectContaining({ hackingLevel: 42, portOpenersOwned: 3 }),
      });
    });

    it("reflects state mutated after the handlers were built (e.g. by the background refresh task)", () => {
      const state = createSupervisorState();
      const handlers = createPlayerHandlers(state);

      state.player.hackingLevel = 100;
      state.player.portOpenersOwned = 5;

      expect(handlers.GetPlayerMetadata({})).toEqual({
        player: expect.objectContaining({ hackingLevel: 100, portOpenersOwned: 5 }),
      });
    });

    it("also serves the rest of the player's skills", () => {
      const state = createSupervisorState();
      const handlers = createPlayerHandlers(state);

      state.player.strength = 10;
      state.player.defense = 20;
      state.player.dexterity = 30;
      state.player.agility = 40;
      state.player.charisma = 50;
      state.player.intelligence = 60;

      expect(handlers.GetPlayerMetadata({})).toEqual({
        player: expect.objectContaining({ strength: 10, defense: 20, dexterity: 30, agility: 40, charisma: 50, intelligence: 60 }),
      });
    });
  });

  describe("PatchPlayerMetadata", () => {
    it("merges a defined field into state.player, visible to a later GetPlayerMetadata", () => {
      const state = createSupervisorState();
      const handlers = createPlayerHandlers(state);

      const res = handlers.PatchPlayerMetadata({ player: { singularityAvailable: true } });

      expect(res).toEqual({});
      expect(state.player.singularityAvailable).toBe(true);
      expect(handlers.GetPlayerMetadata({})).toEqual({
        player: expect.objectContaining({ singularityAvailable: true }),
      });
    });

    it("ignores explicitly-undefined fields rather than clobbering existing state", () => {
      const state = createSupervisorState(new Map(), new Set(), 42);
      const handlers = createPlayerHandlers(state);

      handlers.PatchPlayerMetadata({ player: { hackingLevel: undefined, singularityAvailable: true } });

      expect(state.player.hackingLevel).toBe(42);
      expect(state.player.singularityAvailable).toBe(true);
    });

    it("does nothing when no player field is given", () => {
      const state = createSupervisorState(new Map(), new Set(), 42, 3);
      const handlers = createPlayerHandlers(state);
      const before = { ...state.player };

      const res = handlers.PatchPlayerMetadata({});

      expect(res).toEqual({});
      expect(state.player).toEqual(before);
      expect(state.playerStateDirty).toBe(false);
    });

    it("marks playerStateDirty so flush() persists the change", () => {
      const state = createSupervisorState();
      const handlers = createPlayerHandlers(state);

      expect(state.playerStateDirty).toBe(false);
      handlers.PatchPlayerMetadata({ player: { singularityAvailable: true } });

      expect(state.playerStateDirty).toBe(true);
    });
  });
});
