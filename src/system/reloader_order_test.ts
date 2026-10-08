import { describe, expect, it } from "vitest";
import { revivalOrder } from "system/reloader";

describe("revivalOrder", () => {
  it("revives in boot's priority order, unknown scripts last", () => {
    const keys = ["crime|", "hacknet|", "other|", "planner|"];
    const scriptOf = (k: string): string => ({ "crime|": "factions/services/crime_service.js", "hacknet|": "economy/hacknet_daemon.js", "planner|": "factions/faction_daemon.js", "other|": "x.js" })[k] ?? "";
    expect(revivalOrder(keys, scriptOf, ["economy/hacknet_daemon.js", "factions/services/crime_service.js", "factions/faction_daemon.js"])).toEqual(["hacknet|", "crime|", "planner|", "other|"]);
  });
});
