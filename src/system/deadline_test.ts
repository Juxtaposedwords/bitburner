import { describe, expect, it } from "vitest";
import { deadlineIn, expired, NO_DEADLINE, remainingMs, toDeadline, within } from "system/deadline";

describe("deadline", () => {
  it("expires at its time", () => {
    const d = deadlineIn(100, 1000);
    expect(expired(d, 1099)).toBe(false);
    expect(expired(d, 1100)).toBe(true);
    expect(remainingMs(d, 1050)).toBe(50);
    expect(expired(undefined)).toBe(false);
    expect(expired(NO_DEADLINE)).toBe(false);
  });

  it("gives sub-steps the nearer of their own budget and the parent's", () => {
    expect(within(deadlineIn(100, 0), 50, 0).at).toBe(50);
    expect(within(deadlineIn(100, 0), 500, 0).at).toBe(100);
    expect(within(undefined, 30, 0).at).toBe(30);
  });

  it("reads a number as milliseconds from now", () => {
    expect(toDeadline(250, 1000).at).toBe(1250);
    expect(toDeadline({ at: 7 })).toEqual({ at: 7 });
  });
});
