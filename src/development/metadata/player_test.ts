import { describe, expect, it } from "vitest";
import { hackingLevelChanged } from "development/metadata/player";

describe("hackingLevelChanged", () => {
  it.each([
    { name: "no previous reading yet", previous: undefined, current: 50, expected: false },
    { name: "level increased since last reading", previous: 40, current: 50, expected: true },
    { name: "level unchanged since last reading", previous: 50, current: 50, expected: false },
  ])("$name", ({ previous, current, expected }) => {
    expect(hackingLevelChanged(previous, current)).toBe(expected);
  });
});
