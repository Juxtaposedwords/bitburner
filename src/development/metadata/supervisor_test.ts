import { describe, expect, it } from "vitest";
import { createHandlers, createSupervisorState } from "development/metadata/supervisor";
import { Logger } from "development/libraries/logs";
import { Metadata } from "development/metadata/server_metadata";

const metadata = (hostname: string, overrides: Partial<Metadata> = {}): Metadata => ({
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

      expect(res).toEqual({ success: true });
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
        base: { maxRam: 8, hacked: false },
        patch: { hacked: true },
        expected: { maxRam: 8, hacked: true },
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

      expect(res).toEqual({ success: true });
      expect(state.networkState.get("n00dles")).toEqual(metadata("n00dles", expected));
      expect(state.pendingWrites.has("n00dles")).toBe(true);
    });

    it("reports failure for an unknown hostname without touching state", async () => {
      const state = createSupervisorState();
      const handlers = createHandlers(noopLog, state);

      const res = await handlers.PatchMetadata({ server: metadata("unknown-host") });

      expect(res).toEqual({ success: false });
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

      expect(res.servers).toEqual([metadata("n00dles", { maxRam: 8 }), metadata("foodnstuff", { maxRam: 16 })]);
    });

    it("returns an empty list when nothing is known yet", () => {
      const handlers = createHandlers(noopLog, createSupervisorState());

      expect(handlers.ListServers({})).toEqual({ servers: [] });
    });
  });

  describe("hostname validation", () => {
    it.each([{ method: "UpdateMetadata" as const }, { method: "PatchMetadata" as const }])(
      "$method throws when the request has no hostname",
      async ({ method }) => {
        const handlers = createHandlers(noopLog, createSupervisorState());

        // Normalizes UpdateMetadata's synchronous throw and PatchMetadata's
        // rejection into the same assertable shape.
        await expect(Promise.resolve().then(() => handlers[method]({ server: {} as Metadata }))).rejects.toThrow(
          /hostname is required/
        );
      }
    );
  });
});
