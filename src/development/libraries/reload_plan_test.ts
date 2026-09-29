import { describe, expect, it } from "vitest";
import { decideReloads, fingerprint, importedScripts } from "development/libraries/reload_plan";

describe("importedScripts", () => {
  it("finds script imports and skips packages", () => {
    const source = [
      'import { NS } from "@ns";',
      'import { loadJsonConfig } from "development/libraries/config";',
      'import * as pb from "development/metadata/player_metadata";',
      'import { x, } from "development/libraries/logs.js";',
    ].join("\n");
    expect(importedScripts(source)).toEqual([
      "development/libraries/config.js",
      "development/metadata/player_metadata.js",
      "development/libraries/logs.js",
    ]);
  });
});

describe("importedScripts ignores look-alikes", () => {
  it("skips quotes inside comments and strings", () => {
    const source = [
      "// Only buys once we don't have TIX API, saving up for the",
      "// 4S step's cost before it would import 'anything'.",
      'const s = "import from here";',
      'export const SAVINGS_PATH = "/var/savings.txt";',
      'import "development/libraries/side_effect";',
      'export { thing } from "development/libraries/savings";',
    ].join("\n");
    expect(importedScripts(source)).toEqual(["development/libraries/side_effect.js", "development/libraries/savings.js"]);
  });
});

describe("fingerprint", () => {
  const files: Record<string, string> = {
    "a.js": 'import { b } from "lib/b";',
    "lib/b.js": 'import { c } from "lib/c"; export const b = 1;',
    "lib/c.js": "export const c = 1;",
  };
  const read = (fs: Record<string, string>) => (path: string) => fs[path] ?? "";

  it("changes when a transitive import changes", () => {
    const before = fingerprint("a.js", read(files));
    const after = fingerprint("a.js", read({ ...files, "lib/c.js": "export const c = 2;" }));
    expect(after).not.toBe(before);
  });

  it("is stable when nothing changed", () => {
    expect(fingerprint("a.js", read(files))).toBe(fingerprint("a.js", read({ ...files })));
  });

  it("survives import cycles", () => {
    const cyclic = { "a.js": 'import "lib/b";', "lib/b.js": 'import "a";' };
    expect(fingerprint("a.js", read(cyclic))).toMatch(/^[0-9a-f]+$/);
  });
});

describe("decideReloads", () => {
  it("records new processes without restarting them", () => {
    const { restart, tracked } = decideReloads(new Map(), [{ pid: 1, signature: "s1" }]);
    expect(restart).toEqual([]);
    expect(tracked.get(1)).toEqual({ signature: "s1" });
  });

  it("restarts only after a changed fingerprint holds for a second check", () => {
    const first = decideReloads(new Map([[1, { signature: "s1" }]]), [{ pid: 1, signature: "s2" }]);
    expect(first.restart).toEqual([]);
    const second = decideReloads(first.tracked, [{ pid: 1, signature: "s2" }]);
    expect(second.restart).toEqual([1]);
  });

  it("keeps waiting while files are still changing mid-sync", () => {
    const first = decideReloads(new Map([[1, { signature: "s1" }]]), [{ pid: 1, signature: "s2" }]);
    const second = decideReloads(first.tracked, [{ pid: 1, signature: "s3" }]);
    expect(second.restart).toEqual([]);
    expect(second.tracked.get(1)).toEqual({ signature: "s1", pending: "s3" });
  });

  it("forgets processes that have exited", () => {
    const { tracked } = decideReloads(new Map([[1, { signature: "s1" }]]), []);
    expect(tracked.size).toBe(0);
  });
});
