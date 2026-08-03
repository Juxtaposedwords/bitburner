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
        config: { approach: Approach.HACK, hackFraction: 0.1, spacingMs: 200, homeFallbackHackingLevel: 50, homeReservedRamGb: 5 },
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
  const fakeNs = (weightsFileContent?: string): NS =>
    ({
      read: (() => weightsFileContent ?? "") as NS["read"],
      write: (() => {}) as NS["write"],
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

  it("returns undefined when no weights file exists yet and no override is set", () => {
    const ns = fakeNs();
    expect(resolveTarget(ns, {})).toBeUndefined();
  });
});
