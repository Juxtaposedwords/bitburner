import { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { rotateIfNeeded } from "tools/log_rotator";

const fakeNs = (files: Record<string, string> = {}): NS => {
  const disk = new Map(Object.entries(files));

  const base: Partial<NS> = {
    read: ((filename: string) => disk.get(filename) ?? "") as NS["read"],
    write: ((filename: string, data: string = "", _mode: "w" | "a" = "w") => {
      disk.set(filename, data);
    }) as NS["write"],
  };

  return new Proxy(base as NS, {
    get(obj, prop, receiver) {
      if (Reflect.has(obj, prop)) return Reflect.get(obj, prop, receiver);
      throw new Error(`[fakeNs] ns.${String(prop)} is not mocked in this test file.`);
    },
  });
};

describe("rotateIfNeeded", () => {
  it("leaves a file under the size threshold untouched", () => {
    const ns = fakeNs({ "/var/log/home/Test.txt": "small" });

    rotateIfNeeded(ns, "/var/log/home/Test.txt");

    expect(ns.read("/var/log/home/Test.txt")).toBe("small");
    expect(ns.read("/var/log/home/Test.1.txt")).toBe("");
  });

  // Backup filenames insert the generation suffix before ".txt" (Test.1.txt),
  // not after (Test.txt.1) - ns.write rejects any filename whose actual
  // extension isn't one of its allowed types, and ".1" isn't one of them.
  it("copies the full contents to a .1.txt backup and truncates the original once over threshold", () => {
    const big = "x".repeat(100_001);
    const ns = fakeNs({ "/var/log/home/Test.txt": big });

    rotateIfNeeded(ns, "/var/log/home/Test.txt");

    expect(ns.read("/var/log/home/Test.txt")).toBe("");
    expect(ns.read("/var/log/home/Test.1.txt")).toBe(big);
  });

  it("overwrites a prior backup rather than accumulating history", () => {
    const ns = fakeNs({
      "/var/log/home/Test.txt": "x".repeat(100_001),
      "/var/log/home/Test.1.txt": "stale backup",
    });

    rotateIfNeeded(ns, "/var/log/home/Test.txt");

    expect(ns.read("/var/log/home/Test.1.txt")).toBe("x".repeat(100_001));
  });
});
