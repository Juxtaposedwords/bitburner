import { describe, expect, it } from "vitest";
import { computeGangAvailable, computeSingularityAvailable } from "development/metadata/detect_capabilities";

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

describe("computeGangAvailable", () => {
  it("is available when currently playing BitNode 2, regardless of owned Source-Files", () => {
    expect(computeGangAvailable(2, new Map())).toBe(true);
  });

  it("is available outside BitNode 2 when Source-File 2 is owned at any level", () => {
    expect(computeGangAvailable(1, new Map([[2, 1]]))).toBe(true);
    expect(computeGangAvailable(1, new Map([[2, 3]]))).toBe(true);
  });

  it("is unavailable outside BitNode 2 without Source-File 2", () => {
    expect(computeGangAvailable(1, new Map())).toBe(false);
  });

  it("is unavailable if Source-File 2 is present but its active level is 0", () => {
    expect(computeGangAvailable(1, new Map([[2, 0]]))).toBe(false);
  });

  it("doesn't confuse owning a different Source-File for owning SF2, and is independent of singularityAvailable", () => {
    expect(computeGangAvailable(1, new Map([[4, 3]]))).toBe(false);
  });
});
