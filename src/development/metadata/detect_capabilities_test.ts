import { describe, expect, it } from "vitest";
import { computeSingularityAvailable } from "development/metadata/detect_capabilities";

describe("computeSingularityAvailable", () => {
  it("is available when currently playing BitNode 4, regardless of owned Source-Files", () => {
    expect(computeSingularityAvailable(4, new Map())).toBe(true);
  });

  it("is available outside BitNode 4 when Source-File 4 is owned at any level", () => {
    expect(computeSingularityAvailable(1, new Map([[4, 1]]))).toBe(true);
    expect(computeSingularityAvailable(1, new Map([[4, 3]]))).toBe(true);
  });

  it("is unavailable outside BitNode 4 without Source-File 4", () => {
    expect(computeSingularityAvailable(1, new Map())).toBe(false);
  });

  it("is unavailable if Source-File 4 is present but its active level is 0", () => {
    expect(computeSingularityAvailable(1, new Map([[4, 0]]))).toBe(false);
  });

  it("doesn't confuse owning a different Source-File for owning SF4", () => {
    expect(computeSingularityAvailable(1, new Map([[1, 3]]))).toBe(false);
  });
});
