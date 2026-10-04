import { describe, expect, it } from "vitest";
import { commandAllowed, seedTracked, UNKNOWN_SIGNATURE, daemonKey, decideReloads, decideRevivals, fingerprint, importedScripts, pendingCommands, SeenDaemon } from "system/reload_plan";

describe("importedScripts", () => {
  it("finds script imports and skips packages", () => {
    const source = [
      'import { NS } from "@ns";',
      'import { loadJsonConfig } from "system/config";',
      'import * as pb from "system/rpc/player_metadata";',
      'import { x, } from "system/logs.js";',
    ].join("\n");
    expect(importedScripts(source)).toEqual([
      "system/config.js",
      "system/rpc/player_metadata.js",
      "system/logs.js",
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
      'export { thing } from "system/savings";',
    ].join("\n");
    expect(importedScripts(source)).toEqual(["development/libraries/side_effect.js", "system/savings.js"]);
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

describe("decideRevivals", () => {
  const sleeve: SeenDaemon = { filename: "sleeves/sleeve_daemon.js", threads: 1, args: [] };
  const key = daemonKey(sleeve.filename, sleeve.args);
  const seen = new Map([[key, sleeve]]);
  const NOW = 10 * 3600_000;

  it("revives a daemon that was running and is gone", () => {
    expect(decideRevivals(seen, new Set(), new Map(), NOW, 3)).toEqual({ revive: [key], giveUp: [] });
  });

  it("leaves running daemons alone", () => {
    expect(decideRevivals(seen, new Set([key]), new Map(), NOW, 3)).toEqual({ revive: [], giveUp: [] });
  });

  it("gives up after maxPerHour revivals within the hour, and tries again after", () => {
    const history = new Map([[key, [NOW - 1000, NOW - 2000, NOW - 3000]]]);
    expect(decideRevivals(seen, new Set(), history, NOW, 3)).toEqual({ revive: [], giveUp: [key] });
    const old = new Map([[key, [NOW - 2 * 3600_000, NOW - 1000, NOW - 2000]]]);
    expect(decideRevivals(seen, new Set(), old, NOW, 3).revive).toEqual([key]);
  });

  it("keys a daemon by script and args, ignoring a leading slash", () => {
    expect(daemonKey("/hacking/program_shopper.js", ["--once"])).toBe(daemonKey("hacking/program_shopper.js", ["--once"]));
  });
});

describe("queued commands", () => {
  const raw = JSON.stringify({
    commands: [
      { id: "1", script: "tools/set_config.js", args: ["/etc/gang.txt", "territoryWarfareMembers", 12] },
      { id: "2", script: "sleeves/sleeve_daemon.js" },
      { id: "3", script: "system/bootstrap/bootstrap.js" },
    ],
  });

  it("returns commands not yet done, flagging what's not allowed", () => {
    expect(pendingCommands(raw, new Set(["1"])).map((p) => [p.command.id, p.allowed])).toEqual([
      ["2", true],
      ["3", false],
    ]);
  });

  it("accepts a bare array and ignores junk", () => {
    expect(pendingCommands('[{"id":"a","script":"tools/status.js"}]', new Set()).length).toBe(1);
    expect(pendingCommands("not json", new Set())).toEqual([]);
    expect(pendingCommands('[{"script":"tools/x.js"}]', new Set())).toEqual([]);
  });

  it("allows only tools and managed daemons", () => {
    expect(commandAllowed("/tools/set_config.js")).toBe(true);
    expect(commandAllowed("gang/gang_daemon.js")).toBe(true);
    expect(commandAllowed("hacking/workers/hack_worker.js")).toBe(false);
    expect(commandAllowed("hacking/target_selector.js")).toBe(true);
  });
});

describe("seedTracked", () => {
  it("uses saved fingerprints, and marks older processes without one for a restart", () => {
    const tracked = seedTracked({ "5": "abc" }, [{ pid: 5, ageSec: 900 }, { pid: 9, ageSec: 900 }]);
    expect(tracked.get(5)).toEqual({ signature: "abc" });
    expect(tracked.get(9)).toEqual({ signature: UNKNOWN_SIGNATURE });
  });

  it("adopts a process boot just started instead of restarting it", () => {
    const seeded = seedTracked({}, [{ pid: 12, ageSec: 5 }]);
    expect(seeded.has(12)).toBe(false);
    const first = decideReloads(seeded, [{ pid: 12, signature: "now" }]);
    expect(decideReloads(first.tracked, [{ pid: 12, signature: "now" }]).restart).toEqual([]);
  });

  it("restarts an unknown process after the usual one-check hold", () => {
    const first = decideReloads(seedTracked({}, [{ pid: 9, ageSec: 900 }]), [{ pid: 9, signature: "new" }]);
    expect(first.restart).toEqual([]);
    expect(decideReloads(first.tracked, [{ pid: 9, signature: "new" }]).restart).toEqual([9]);
  });
});
