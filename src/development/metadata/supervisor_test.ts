import { describe, expect, it } from "vitest";
import { computeStatus, createHandlers, createSupervisorState, isEligible, isRootable } from "development/metadata/supervisor";
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
        base: { maxRam: 8, status: server_metadata_pb.ServerStatus.DISCOVERED },
        patch: { status: server_metadata_pb.ServerStatus.ROOTED },
        expected: { maxRam: 8, status: server_metadata_pb.ServerStatus.ROOTED },
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
    it("returns every currently-known server", async () => {
      const state = createSupervisorState(
        new Map([
          ["n00dles", metadata("n00dles", { maxRam: 8 })],
          ["foodnstuff", metadata("foodnstuff", { maxRam: 16 })],
        ])
      );
      const handlers = createHandlers(noopLog, state);

      const res = await handlers.ListServers({});

      expect(res.servers).toEqual([
        metadata("n00dles", { maxRam: 8, status: server_metadata_pb.ServerStatus.DISCOVERED }),
        metadata("foodnstuff", { maxRam: 16, status: server_metadata_pb.ServerStatus.DISCOVERED }),
      ]);
    });

    it("returns an empty list when nothing is known yet", () => {
      const handlers = createHandlers(noopLog, createSupervisorState());

      expect(handlers.ListServers({})).toEqual({ servers: [] });
    });

    it("filters to only eligible servers when eligibleOnly is set", async () => {
      const eligible = metadata("n00dles", { status: server_metadata_pb.ServerStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 5 } } });
      const notRooted = metadata("foodnstuff", { status: server_metadata_pb.ServerStatus.DISCOVERED, maxMoney: 1000 });
      const levelTooHigh = metadata("joesguns", { status: server_metadata_pb.ServerStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 500 } } });

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

      expect(res.servers).toEqual([{ ...eligible, status: server_metadata_pb.ServerStatus.ELIGIBLE }]);
    });
  });

  describe("isEligible", () => {
    const base = metadata("n00dles", { status: server_metadata_pb.ServerStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 50 } } });

    it.each([
      { name: "rooted, has money, and within reach", overrides: {}, hackingLevel: 100, expected: true },
      { name: "not rooted", overrides: { status: server_metadata_pb.ServerStatus.DISCOVERED }, hackingLevel: 100, expected: false },
      { name: "no money to steal", overrides: { maxMoney: 0 }, hackingLevel: 100, expected: false },
      { name: "hacking level requirement not yet met", overrides: {}, hackingLevel: 10, expected: false },
      { name: "unknown hacking requirement fails closed", overrides: { hacking: undefined }, hackingLevel: 100, expected: false },
    ])("$name", ({ overrides, hackingLevel, expected }) => {
      expect(isEligible({ ...base, ...overrides }, hackingLevel)).toBe(expected);
    });
  });

  describe("isRootable", () => {
    const base = metadata("n00dles", { status: server_metadata_pb.ServerStatus.DISCOVERED, hacking: { requirements: { ports: 2 } } });

    it.each([
      { name: "enough port-openers owned", overrides: {}, portOpenersOwned: 2, expected: true },
      { name: "not enough port-openers owned", overrides: {}, portOpenersOwned: 1, expected: false },
      { name: "already rooted", overrides: { status: server_metadata_pb.ServerStatus.ROOTED }, portOpenersOwned: 5, expected: false },
      { name: "unknown port requirement fails closed", overrides: { hacking: undefined }, portOpenersOwned: 5, expected: false },
    ])("$name", ({ overrides, portOpenersOwned, expected }) => {
      expect(isRootable({ ...base, ...overrides }, portOpenersOwned)).toBe(expected);
    });
  });

  describe("computeStatus", () => {
    const eligible = metadata("n00dles", { status: server_metadata_pb.ServerStatus.ROOTED, maxMoney: 1000, hacking: { requirements: { level: 5 } } });

    it.each([
      { name: "not rooted, not enough ports open", server: metadata("a", { status: server_metadata_pb.ServerStatus.DISCOVERED, hacking: { requirements: { ports: 2 } } }), hackingLevel: 100, portOpenersOwned: 0, expected: server_metadata_pb.ServerStatus.DISCOVERED },
      { name: "not rooted, enough ports open", server: metadata("a", { status: server_metadata_pb.ServerStatus.DISCOVERED, hacking: { requirements: { ports: 2 } } }), hackingLevel: 100, portOpenersOwned: 2, expected: server_metadata_pb.ServerStatus.ROOTABLE },
      { name: "rooted, but hacking level not yet met", server: eligible, hackingLevel: 1, portOpenersOwned: 0, expected: server_metadata_pb.ServerStatus.ROOTED },
      { name: "rooted, hackable", server: eligible, hackingLevel: 100, portOpenersOwned: 0, expected: server_metadata_pb.ServerStatus.ELIGIBLE },
    ])("$name", ({ server, hackingLevel, portOpenersOwned, expected }) => {
      expect(computeStatus(server, hackingLevel, portOpenersOwned)).toBe(expected);
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
