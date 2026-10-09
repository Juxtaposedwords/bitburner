import { describe, expect, it } from "vitest";
import { planPlacement, Unit } from "system/placement_plan";

const unit = (script: string, ram: number, homeOnly = false): Unit => ({ script, ram, homeOnly });

describe("planPlacement", () => {
  it("keeps home for home-only daemons, putting movable ones on hacked servers", () => {
    const plan = planPlacement([unit("service", 11.6), unit("monitoring", 12.3, true)], 15, [{ host: "foodnstuff", free: 16 }]);
    expect(plan.held).toBeUndefined();
    expect(plan.placed).toEqual(
      expect.arrayContaining([
        { script: "service", host: "foodnstuff", alreadyRunning: false },
        { script: "monitoring", host: "home", alreadyRunning: false },
      ])
    );
  });

  it("holds at the first unit that can't fit, placing nothing after it", () => {
    const plan = planPlacement([unit("big", 40), unit("small", 5)], 10, [{ host: "a", free: 16 }]);
    expect(plan.held).toBe("big");
    expect(plan.placed).toEqual([]);
  });

  it("uses the smallest server that fits, and home's leftover last", () => {
    const plan = planPlacement([unit("x", 10), unit("y", 30)], 50, [{ host: "s16", free: 16 }, { host: "s32", free: 32 }]);
    expect(plan.placed.find((p) => p.script === "y")?.host).toBe("s32");
    expect(plan.placed.find((p) => p.script === "x")?.host).toBe("s16");
  });

  it("keeps running daemons where they are", () => {
    const plan = planPlacement([{ ...unit("gang", 32.6), runningOn: "silver-helix" }, unit("study", 25.2)], 0, [{ host: "silver-helix", free: 64 - 32.6 }]);
    expect(plan.placed).toEqual(
      expect.arrayContaining([
        { script: "gang", host: "silver-helix", alreadyRunning: true },
        { script: "study", host: "silver-helix", alreadyRunning: false },
      ])
    );
  });
});

// BitNode 9 on 2026-10-09, from the game: a 128 GB home and the rooted hacked
// servers, against boot's order with each daemon's size (build/ram_estimate.mjs).
describe("BitNode 9's real numbers", () => {
  const hacked = [
    ["silver-helix", 64], ["zer0", 32], ["phantasy", 32], ["omega-net", 32], ["neo-net", 32], ["max-hardware", 32], ["iron-gym", 32],
    ["the-hub", 16], ["sigma-cosmetics", 16], ["nectar-net", 16], ["joesguns", 16], ["hong-fang-tea", 16], ["harakiri-sushi", 16], ["foodnstuff", 16], ["avmnite-02h", 16],
    ["CSEC", 8], ["n00dles", 4],
  ].map(([host, free]) => ({ host: host as string, free: free as number }));
  // Home: 128 GB less the core boot starts first (supervisor, log rotator,
  // player, reloader, network daemon: 21.75 GB) and boot itself (14.4 GB).
  const homeFree = 128 - 21.75 - 14.4;
  const order: Unit[] = [
    unit("scheduler", 11.95, true),
    unit("program_shopper", 12.15, true),
    unit("hacknet", 12.05, true),
    ...[11.6, 11.6, 11.6, 6.6, 11.6, 6.25, 10.65, 10.6, 10.6, 9.7, 13.1].map((ram, i) => unit(`faction_service_${i}`, ram)),
    unit("faction_daemon", 7.75),
    unit("gang", 32.65),
    unit("study", 25.2),
    unit("monitoring", 12.35, true),
    unit("backdoor", 6, true),
    unit("stock", 24.95),
    unit("stock_target", 8, true),
    unit("share", 5.35, true),
    unit("go", 9.65, true),
  ];

  it("places every daemon (the sleeve daemon stopped)", () => {
    const plan = planPlacement(order, homeFree, hacked);
    expect(plan.held).toBeUndefined();
    expect(plan.placed).toHaveLength(order.length);
    expect(plan.placed.find((p) => p.script === "monitoring")?.host).toBe("home");
  });

  it("with the 63.5 GB sleeve daemon too, the higher-priority daemons get the room", () => {
    const withSleeves = [...order.slice(0, 15), unit("sleeve", 63.45), ...order.slice(15)];
    const plan = planPlacement(withSleeves, homeFree, hacked);
    // The sleeve daemon takes silver-helix, so the 32.65 GB gang daemon (no
    // 32 GB server fits it) falls back to home - and the first daemon that no
    // longer fits is a lower-priority home-only one.
    expect(plan.placed.find((p) => p.script === "sleeve")?.host).toBe("silver-helix");
    expect(plan.placed.find((p) => p.script === "gang")?.host).toBe("home");
    expect(plan.held).toBe("stock_target");
  });
});
