import { describe, expect, it } from "vitest";
import { changed, FORCE_ARG, scriptsToLaunch } from "development/metadata/dispatch";

describe("changed", () => {
  it.each([
    { name: "no previous reading yet", previous: undefined, current: 50, expected: false },
    { name: "value increased since last reading", previous: 40, current: 50, expected: true },
    { name: "value unchanged since last reading", previous: 50, current: 50, expected: false },
  ])("$name", ({ previous, current, expected }) => {
    expect(changed(previous, current)).toBe(expected);
  });
});

describe("scriptsToLaunch", () => {
  const snapshot = (hackingLevel: number, portOpenersOwned: number, rooterMarker = "") => ({
    hackingLevel,
    portOpenersOwned,
    rooterMarker,
  });

  it("launches nothing on the first reading (no previous snapshot)", () => {
    expect(scriptsToLaunch(undefined, snapshot(1, 0))).toEqual([]);
  });

  it("launches nothing when nothing changed", () => {
    expect(scriptsToLaunch(snapshot(50, 2, "a"), snapshot(50, 2, "a"))).toEqual([]);
  });

  it("launches target_selector.js (unforced) when hacking level changes", () => {
    expect(scriptsToLaunch(snapshot(40, 2), snapshot(50, 2))).toEqual([{ script: "development/metadata/target_selector.js" }]);
  });

  it("launches rooter.js when port-openers owned changes", () => {
    expect(scriptsToLaunch(snapshot(50, 1), snapshot(50, 2))).toEqual([{ script: "development/metadata/rooter.js" }]);
  });

  it("launches target_selector.js forced when the rooter's completion marker changes", () => {
    expect(scriptsToLaunch(snapshot(50, 2, "a"), snapshot(50, 2, "b"))).toEqual([
      { script: "development/metadata/target_selector.js", args: [FORCE_ARG] },
    ]);
  });

  it("launches rooter.js and both hacking-level and rooter triggers together, without double-queuing target_selector", () => {
    expect(scriptsToLaunch(snapshot(40, 1, "a"), snapshot(50, 2, "b"))).toEqual([
      { script: "development/metadata/target_selector.js" },
      { script: "development/metadata/rooter.js" },
    ]);
  });
});
