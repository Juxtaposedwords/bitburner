import { describe, expect, it } from "vitest";
import { applyDefined } from "development/libraries/merge";

describe("applyDefined", () => {
  it("overwrites fields present in the patch", () => {
    const target = { a: 1, b: 2 };

    applyDefined(target, { a: 10 });

    expect(target).toEqual({ a: 10, b: 2 });
  });

  it("ignores explicitly-undefined fields rather than clobbering existing values", () => {
    const target = { a: 1, b: 2 };

    applyDefined(target, { a: undefined, b: 20 });

    expect(target).toEqual({ a: 1, b: 20 });
  });

  it("does nothing for an empty patch", () => {
    const target = { a: 1, b: 2 };

    applyDefined(target, {});

    expect(target).toEqual({ a: 1, b: 2 });
  });
});
