import { describe, expect, it } from "vitest";
import { daemonHostSize } from "system/remote_place";
import { matchesState } from "system/remote_state";

describe("daemonHostSize", () => {
  it("is the next power of two with headroom", () => {
    expect(daemonHostSize(100)).toBe(128);
    expect(daemonHostSize(121)).toBe(256);
    expect(daemonHostSize(1)).toBe(16);
  });
});

describe("matchesState", () => {
  it("syncs configs and status, not logs or tool output", () => {
    const pre = ["/etc/", "/var/"];
    const ex = ["/var/log/", "/var/claude_out/"];
    expect(matchesState("var/phase.txt", pre, ex)).toBe(true);
    expect(matchesState("/etc/faction.txt", pre, ex)).toBe(true);
    expect(matchesState("/var/log/home/x.txt", pre, ex)).toBe(false);
    expect(matchesState("/boot.js", pre, ex)).toBe(false);
  });
});
