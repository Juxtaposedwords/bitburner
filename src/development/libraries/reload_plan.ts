/**
 * Pure logic for reloader.ts - no `ns`.
 *
 * New code reaches the game as changed files (bitburner-filesync pushing
 * dist/), but running scripts keep the code they started with, so every
 * change needed a manual restart. reloader.ts fingerprints each managed
 * daemon's file plus everything it imports, and restarts a daemon once its
 * fingerprint changes - after the new one has held for a check, so a
 * restart never lands in the middle of a sync.
 */

/** Long-running daemons the reloader may restart (never workers, one-shot tools, bootstrap, or itself). */
export const MANAGED_DAEMONS = [
  "development/metadata/supervisor.js",
  "tools/log_rotator.js",
  "development/metadata/player.js",
  "development/metadata/scheduler_daemon.js",
  "tools/program_shopper.js",
  "development/metadata/faction_daemon.js",
  "development/metadata/gang_daemon.js",
  "development/metadata/sleeve_daemon.js",
  "development/metadata/hacknet_daemon.js",
  "development/metadata/study_daemon.js",
  "development/metadata/backdoor_daemon.js",
  "development/metadata/stock_daemon.js",
  "development/metadata/stock_target_daemon.js",
  "development/metadata/purchased_server_daemon.js",
  "development/metadata/monitoring_daemon.js",
  "development/metadata/share_daemon.js",
];

/**
 * Script paths a compiled module imports: every `from "x"` / `import "x"`
 * specifier, as "x.js" (the build keeps bare specifiers like
 * "development/libraries/config"). Package imports ("@ns", "react") are
 * type-only or not files on home, so they're skipped.
 */
export function importedScripts(source: string): string[] {
  const specifiers = new Set<string>();
  // Real statements only: a line starting with import/export, its specifier
  // on that line, and path-like. A looser match once read an apostrophe in
  // a comment as a quote and asked the game for a file named "have TIX API,
  // saving up for the 4S step.js", which crashed the reloader.
  // `import "x"` (side effect), or import/export ... from "x". Never a plain
  // `export const P = "/var/x.txt"`.
  const statement = /^\s*(?:import\s*["']([^"'\n]+)["']|(?:import|export)\b[^\n;]*?\bfrom\s*["']([^"'\n]+)["'])/gm;
  for (const m of source.matchAll(statement)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith("@") || !spec.includes("/") || !/^[\w./-]+$/.test(spec)) continue;
    specifiers.add(`${spec.replace(/^\//, "").replace(/\.js$/, "")}.js`);
  }
  return [...specifiers];
}

/** djb2 string hash - enough to tell whether any of the files changed. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Fingerprint of `entry` and every script it imports, transitively.
 * `readFile` returns a script's source ("" if missing).
 */
export function fingerprint(entry: string, readFile: (path: string) => string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFile(path);
    parts.push(`${path}\n${source}`);
    for (const dep of importedScripts(source)) visit(dep);
  };
  visit(entry);
  return hash(parts.sort().join("\n\u0000"));
}

/**
 * Daemons boot.js started (or found running), written by boot.ts. The
 * reloader revives these even if it never saw them running itself: after
 * a game restart, the game brings back only some scripts, and a fresh
 * reloader had nothing to compare against - BN10's second run sat 49
 * minutes without the scheduler, faction, sleeve, hacknet, study and stock
 * daemons.
 */
export const EXPECTED_DAEMONS_PATH = "/var/expected_daemons.txt";

/** What the reloader remembers per running process. */
export type Tracked = { signature: string; pending?: string };

/**
 * Which processes to restart this check, and the updated memory. A process
 * seen for the first time is just recorded. A changed fingerprint is first
 * noted as pending, and restarts only if the next check sees the same one -
 * so a half-synced set of files never triggers a restart.
 */
export function decideReloads(
  tracked: Map<number, Tracked>,
  current: { pid: number; signature: string }[]
): { restart: number[]; tracked: Map<number, Tracked> } {
  const next = new Map<number, Tracked>();
  const restart: number[] = [];
  for (const { pid, signature } of current) {
    const known = tracked.get(pid);
    if (!known || known.signature === signature) {
      next.set(pid, { signature: known?.signature ?? signature });
    } else if (known.pending === signature) {
      restart.push(pid);
    } else {
      next.set(pid, { signature: known.signature, pending: signature });
    }
  }
  return { restart, tracked: next };
}

/** A daemon process as the reloader last saw it running. */
export type SeenDaemon = { filename: string; threads: number; args: (string | number | boolean)[] };

/** Identity of a daemon process across restarts: its script and arguments. */
export function daemonKey(filename: string, args: (string | number | boolean)[]): string {
  return `${filename.replace(/^\//, "")} ${JSON.stringify(args)}`;
}

const HOUR_MS = 3600_000;

/**
 * Daemons seen running that are gone now: crashed, since nothing else stops
 * them (an install or test_restart kills the reloader too). Each is revived
 * at most `maxPerHour` times an hour, so a daemon that dies on start can't
 * loop forever; past that it's given up on (the status check flags it).
 * `history` holds each key's revival times in ms.
 */
export function decideRevivals(
  seen: Map<string, SeenDaemon>,
  runningKeys: Set<string>,
  history: Map<string, number[]>,
  nowMs: number,
  maxPerHour: number
): { revive: string[]; giveUp: string[] } {
  const revive: string[] = [];
  const giveUp: string[] = [];
  for (const key of seen.keys()) {
    if (runningKeys.has(key)) continue;
    const recent = (history.get(key) ?? []).filter((t) => nowMs - t < HOUR_MS);
    (recent.length < maxPerHour ? revive : giveUp).push(key);
  }
  return { revive, giveUp };
}

/**
 * Commands Claude queues from the repo: src/claude/commands.txt is copied
 * to dist/ and pushed into the game by filesync, like any script, and
 * reloader.ts runs each one it hasn't run yet (ids it has are kept
 * game-side in COMMANDS_DONE_PATH). Lets Claude issue a config change or
 * restart a daemon without the player typing it.
 */
export const COMMANDS_PATH = "/claude/commands.txt";
export const COMMANDS_DONE_PATH = "/var/claude_commands_done.txt";
export type QueuedCommand = { id: string; script: string; args?: (string | number | boolean)[]; note?: string };

/** One-shot system scripts safe to re-run on demand (e.g. a forced target re-rank). */
export const QUEUEABLE_ONE_SHOTS = [
  "development/metadata/target_selector.js",
  "development/metadata/crawl_servers.js",
  "development/metadata/rooter.js",
];

/** Only tools, the managed daemons and QUEUEABLE_ONE_SHOTS may be run this way. */
export function commandAllowed(script: string): boolean {
  const file = script.replace(/^\//, "");
  return (file.startsWith("tools/") && file.endsWith(".js")) || MANAGED_DAEMONS.includes(file) || QUEUEABLE_ONE_SHOTS.includes(file);
}

/** Queued commands not yet done, in file order, each with whether it's allowed. Unparseable files queue nothing. */
export function pendingCommands(raw: string, done: Set<string>): { command: QueuedCommand; allowed: boolean }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { commands?: unknown })?.commands;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is QueuedCommand => typeof c?.id === "string" && typeof c?.script === "string" && !done.has(c.id))
    .map((command) => ({ command, allowed: commandAllowed(command.script) }));
}
