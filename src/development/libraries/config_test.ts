import { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { loadJsonConfig } from "development/libraries/config";

const fakeNs = (files: Record<string, string> = {}): NS => {
  const disk = new Map(Object.entries(files));

  return {
    read: ((filename: string) => disk.get(filename) ?? "") as NS["read"],
    write: ((filename: string, data: string = "") => {
      disk.set(filename, data);
    }) as NS["write"],
  } as NS;
};

const DEFAULTS = { intervalMs: 5000, path: "/data/default.txt" };

describe("loadJsonConfig", () => {
  it("writes and returns the defaults when no file exists yet", () => {
    const ns = fakeNs();

    expect(loadJsonConfig(ns, "/etc/test.txt", DEFAULTS)).toEqual(DEFAULTS);
    expect(JSON.parse(ns.read("/etc/test.txt"))).toEqual(DEFAULTS);
  });

  it("fills in fields missing from a partially-written file", () => {
    const ns = fakeNs({ "/etc/test.txt": JSON.stringify({ intervalMs: 9999 }) });

    expect(loadJsonConfig(ns, "/etc/test.txt", DEFAULTS)).toEqual({ intervalMs: 9999, path: DEFAULTS.path });
  });

  it("falls back to defaults entirely on corrupt JSON", () => {
    const ns = fakeNs({ "/etc/test.txt": "not json" });

    expect(loadJsonConfig(ns, "/etc/test.txt", DEFAULTS)).toEqual(DEFAULTS);
  });
});
