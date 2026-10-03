import { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { createHandlers, createSchedulerState, resolveTarget } from "development/metadata/scheduler_daemon";
import { Approach } from "development/metadata/scheduler";

describe("Scheduler RPC handlers", () => {
  describe("GetSchedulerConfig", () => {
    it("returns the default config when nothing has been patched", () => {
      const state = createSchedulerState();
      const handlers = createHandlers(state);

      expect(handlers.GetSchedulerConfig({})).toEqual({
        config: {
          autoHackFraction: true,
          targetUtilization: 0.85,
          maxHackFraction: 0.9,
          hackFraction: 0.05,
          spacingMs: 200,
          homeFallbackHackingLevel: 50,
          homeReservedRamGb: 5,
        },
      });
    });

    it("honors overrides passed to createSchedulerState", () => {
      const state = createSchedulerState({ hackFraction: 0.25 });
      const handlers = createHandlers(state);

      expect(handlers.GetSchedulerConfig({})).toEqual({
        config: expect.objectContaining({ hackFraction: 0.25 }),
      });
    });
  });

  describe("PatchSchedulerConfig", () => {
    it("merges a defined field into state.config, visible to a later GetSchedulerConfig", () => {
      const state = createSchedulerState();
      const handlers = createHandlers(state);

      const res = handlers.PatchSchedulerConfig({ config: { targetOverride: "n00dles" } });

      expect(res).toEqual({});
      expect(state.config.targetOverride).toBe("n00dles");
      expect(handlers.GetSchedulerConfig({})).toEqual({
        config: expect.objectContaining({ targetOverride: "n00dles" }),
      });
    });

    it("ignores explicitly-undefined fields rather than clobbering existing state", () => {
      const state = createSchedulerState({ hackFraction: 0.3 });
      const handlers = createHandlers(state);

      handlers.PatchSchedulerConfig({ config: { hackFraction: undefined, approach: Approach.GROW_STATS } });

      expect(state.config.hackFraction).toBe(0.3);
      expect(state.config.approach).toBe(Approach.GROW_STATS);
    });

    it("hands the merged config to onConfigChanged so main() can persist it to /etc/scheduler.txt", () => {
      const state = createSchedulerState({ hackFraction: 0.05 });
      const persisted: unknown[] = [];
      const handlers = createHandlers(state, (config) => persisted.push({ ...config }));

      handlers.PatchSchedulerConfig({ config: { approach: Approach.STOCK_TARGETING } });

      expect(persisted).toEqual([expect.objectContaining({ approach: Approach.STOCK_TARGETING, hackFraction: 0.05 })]);
    });

    it("doesn't call onConfigChanged when the patch carries no config", () => {
      const state = createSchedulerState();
      let calls = 0;
      const handlers = createHandlers(state, () => calls++);

      handlers.PatchSchedulerConfig({});

      expect(calls).toBe(0);
    });

    it("does nothing when no config field is given", () => {
      const state = createSchedulerState();
      const handlers = createHandlers(state);
      const before = { ...state.config };

      const res = handlers.PatchSchedulerConfig({});

      expect(res).toEqual({});
      expect(state.config).toEqual(before);
    });
  });
});

describe("resolveTarget", () => {
  const fakeNs = (weightsFileContent?: string, rooted: (host: string) => boolean = () => true): NS =>
    ({
      read: (() => weightsFileContent ?? "") as NS["read"],
      write: (() => {}) as NS["write"],
      hasRootAccess: rooted as NS["hasRootAccess"],
    }) as NS;

  it("prefers config.targetOverride when set, without touching weights.txt", () => {
    const ns = fakeNs();
    expect(resolveTarget(ns, { targetOverride: "n00dles" })).toBe("n00dles");
  });

  it("falls back to the top entry in target_selector.ts's weights.txt", () => {
    const weightsFile = {
      hackingLevel: 50,
      computedAt: 123,
      weights: [
        { hostname: "joesguns", weight: 100 },
        { hostname: "n00dles", weight: 10 },
      ],
    };
    const ns = fakeNs(JSON.stringify(weightsFile));

    expect(resolveTarget(ns, {})).toBe("joesguns");
  });

  it("skips a top pick the player hasn't actually nuked yet", () => {
    const weightsFile = { hackingLevel: 50, computedAt: 123, weights: [{ hostname: "max-hardware", weight: 100 }, { hostname: "joesguns", weight: 10 }] };
    const ns = fakeNs(JSON.stringify(weightsFile), (host) => host !== "max-hardware");
    expect(resolveTarget(ns, {})).toBe("joesguns");
  });

  it("returns undefined when no weights file exists yet and no override is set", () => {
    const ns = fakeNs();
    expect(resolveTarget(ns, {})).toBeUndefined();
  });

  describe("Approach.STOCK_TARGETING", () => {
    // Keyed by path, unlike the single-file fakeNs above - this mode reads
    // TWO weights files (stock_target_daemon.ts's and target_selector.ts's).
    const fakeNsByPath = (filesByPath: Record<string, string>): NS =>
      ({
        read: ((path: string) => filesByPath[path] ?? "") as NS["read"],
        write: (() => {}) as NS["write"],
        hasRootAccess: (() => true) as NS["hasRootAccess"],
      }) as NS;

    const stockWeights = (hostname: string) => JSON.stringify({ hackingLevel: 0, computedAt: 0, weights: [{ hostname, weight: 1 }] });
    const normalWeights = (hostname: string) =>
      JSON.stringify({ hackingLevel: 50, computedAt: 0, weights: [{ hostname, weight: 1 }] });

    it("prefers stock_target_daemon.ts's top pick over the normal ranking", () => {
      const ns = fakeNsByPath({
        "/var/stock_target_selector/weights.txt": stockWeights("ecorp-server"),
        "/var/target_selector/weights.txt": normalWeights("joesguns"),
      });

      expect(resolveTarget(ns, { approach: Approach.STOCK_TARGETING })).toBe("ecorp-server");
    });

    it("falls back to the normal ranking when nothing is stock-linked-and-held-long right now", () => {
      const ns = fakeNsByPath({ "/var/target_selector/weights.txt": normalWeights("joesguns") });

      expect(resolveTarget(ns, { approach: Approach.STOCK_TARGETING })).toBe("joesguns");
    });

    it("still lets targetOverride win over STOCK_TARGETING, same as it wins over HACK", () => {
      const ns = fakeNsByPath({ "/var/stock_target_selector/weights.txt": stockWeights("ecorp-server") });

      expect(resolveTarget(ns, { approach: Approach.STOCK_TARGETING, targetOverride: "n00dles" })).toBe("n00dles");
    });

    it("plain Approach.HACK never consults stock_target_daemon.ts's weights file", () => {
      const ns = fakeNsByPath({
        "/var/stock_target_selector/weights.txt": stockWeights("ecorp-server"),
        "/var/target_selector/weights.txt": normalWeights("joesguns"),
      });

      expect(resolveTarget(ns, { approach: Approach.HACK })).toBe("joesguns");
    });
  });
});
