import { NS } from "@ns";
import {
  COMMANDS_DONE_PATH,
  COMMANDS_PATH,
  daemonKey,
  EXPECTED_DAEMONS_PATH,
  decideReloads,
  decideRevivals,
  fingerprint,
  MANAGED_DAEMONS,
  pendingCommands,
  SeenDaemon,
  Tracked,
} from "development/libraries/reload_plan";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";

/**
 * Keeps the managed daemons running current code (see reload_plan.ts):
 *
 * - Restarts a running daemon when its code changes. New builds reach the
 *   game as files through bitburner-filesync, but a running script keeps
 *   the code it started with. Every CHECK_INTERVAL_MS it fingerprints each
 *   managed daemon on home (its file plus everything it imports) and
 *   restarts - kill, then run with the same threads and arguments - any
 *   whose fingerprint changed and then held for one check.
 * - Revives a daemon it saw running that has since disappeared (a crash),
 *   at most MAX_REVIVALS_PER_HOUR times an hour, logging the dead script's
 *   last log lines so the crash is visible. `--once` runs finish on
 *   purpose and are never tracked.
 * - Exits when its own code changes; tools/log_rotator.js restarts it.
 * - Runs commands Claude queues in /claude/commands.txt (pushed from the
 *   repo by filesync): each id once, tools and managed daemons only, each
 *   echoed to the terminal (runQueuedCommands).
 *
 * Never touches workers, one-shot tools or bootstrap. Small on purpose:
 * boot.js starts it with the first daemons.
 */
const CHECK_INTERVAL_MS = 10_000;
const MAX_REVIVALS_PER_HOUR = 3;
const CRASH_LOG_LINES = 5;
// A queued command that can't start (no RAM) is retried this many checks.
const MAX_COMMAND_ATTEMPTS = 30;

/** Managed daemons boot.js started (EXPECTED_DAEMONS_PATH); [] if it hasn't run or the file is unreadable. */
function readExpectedDaemons(ns: NS): string[] {
  try {
    const list = JSON.parse(ns.read(EXPECTED_DAEMONS_PATH) || "[]") as unknown;
    return Array.isArray(list) ? list.map(String).map((f) => f.replace(/^\//, "")).filter((f) => MANAGED_DAEMONS.includes(f)) : [];
  } catch {
    return [];
  }
}
const commandAttempts = new Map<string, number>();

/** Runs each queued command not yet done (pendingCommands), recording its id game-side. */
async function runQueuedCommands(ns: NS, log: Logger): Promise<void> {
  const done = new Set<string>((ns.read(COMMANDS_DONE_PATH) || "").split("\n").filter(Boolean));
  const markDone = (id: string): void => {
    done.add(id);
    ns.write(COMMANDS_DONE_PATH, [...done].join("\n"), "w");
  };
  for (const { command, allowed } of pendingCommands(ns.read(COMMANDS_PATH), done)) {
    const label = `${command.script} ${(command.args ?? []).map((a) => JSON.stringify(a)).join(" ")}`.trim();
    if (!allowed) {
      ns.tprint(`[Claude] Refused queued command ${command.id} (${label}): only tools/ scripts and managed daemons may run.`);
      await log.warn(`[Reloader] Refused queued command ${command.id}: ${label}`);
      markDone(command.id);
      continue;
    }
    const pid = ns.run(command.script, 1, ...(command.args ?? []));
    if (pid !== 0) {
      ns.tprint(`[Claude] Ran ${label}${command.note ? ` - ${command.note}` : ""} (pid ${pid}).`);
      await log.info(`[Reloader] Ran queued command ${command.id}: ${label}`);
      markDone(command.id);
      continue;
    }
    const attempts = (commandAttempts.get(command.id) ?? 0) + 1;
    commandAttempts.set(command.id, attempts);
    if (attempts >= MAX_COMMAND_ATTEMPTS) {
      ns.tprint(`[Claude] Gave up on ${label}: couldn't start it in ${attempts} tries (RAM?).`);
      markDone(command.id);
    }
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Reloader", LOG_LEVEL.INFO);
  await log.info("=== Reloader online ===");

  const self = ns.getScriptName().replace(/^\//, "");
  let selfSignature: Tracked | undefined;
  let tracked = new Map<number, Tracked>();
  const seen = new Map<string, SeenDaemon>();
  // Seeded with what boot.js started (EXPECTED_DAEMONS_PATH), so a daemon
  // missing after a game restart is revived too, not just ones that die
  // while this reloader watches.
  for (const file of readExpectedDaemons(ns)) seen.set(daemonKey(file, []), { filename: file, threads: 1, args: [] });
  const revivals = new Map<string, number[]>();
  const givenUp = new Set<string>();

  while (true) {
    const processes = ns.ps("home").filter((p) => MANAGED_DAEMONS.includes(p.filename.replace(/^\//, "")));
    const sources = new Map<string, string>();
    // An unreadable path counts as an empty file rather than crashing the loop.
    const read = (path: string): string => {
      if (!sources.has(path)) {
        let source = "";
        try {
          source = ns.read(path) || ns.read(`/${path}`);
        } catch {
          source = "";
        }
        sources.set(path, source);
      }
      return sources.get(path) as string;
    };

    // Itself: same hold-for-one-check rule as the daemons, then exit -
    // tools/log_rotator.js starts it again with the new code. ns.spawn of
    // itself once left no reloader running at all (and so no command queue).
    const selfCheck = decideReloads(selfSignature ? new Map([[0, selfSignature]]) : new Map(), [{ pid: 0, signature: fingerprint(self, read) }]);
    if (selfCheck.restart.length > 0) {
      await log.info(`[Reloader] ${self} changed; exiting for log_rotator.js to start the new version.`);
      return;
    }
    selfSignature = selfCheck.tracked.get(0);

    const decision = decideReloads(
      tracked,
      processes.map((p) => ({ pid: p.pid, signature: fingerprint(p.filename.replace(/^\//, ""), read) }))
    );
    tracked = decision.tracked;

    for (const pid of decision.restart) {
      const p = processes.find((proc) => proc.pid === pid);
      if (!p) continue;
      ns.kill(pid);
      const newPid = ns.run(p.filename, p.threads, ...p.args);
      if (newPid === 0) await log.warn(`[Reloader] ${p.filename} changed; killed it but couldn't restart it (RAM?).`);
      else await log.info(`[Reloader] ${p.filename} changed; restarted (pid ${pid} -> ${newPid}).`);
    }

    // Crashes: anything seen before and missing now (restarts above are
    // already running again under their new pid).
    const running = ns.ps("home").filter((p) => MANAGED_DAEMONS.includes(p.filename.replace(/^\//, "")));
    const runningKeys = new Set(running.map((p) => daemonKey(p.filename, p.args)));
    const { revive, giveUp } = decideRevivals(seen, runningKeys, revivals, Date.now(), MAX_REVIVALS_PER_HOUR);
    for (const key of revive) {
      const d = seen.get(key) as SeenDaemon;
      const dead = ns.getRecentScripts().find((r) => r.filename.replace(/^\//, "") === d.filename.replace(/^\//, ""));
      const tail = dead ? dead.logs.slice(-CRASH_LOG_LINES).map(String).join(" | ") : "no log kept";
      revivals.set(key, [...(revivals.get(key) ?? []).filter((t) => Date.now() - t < 3600_000), Date.now()]);
      givenUp.delete(key);
      const pid = ns.run(d.filename, d.threads, ...d.args);
      await log.warn(
        `[Reloader] ${d.filename} stopped running; ${pid === 0 ? "couldn't restart it (RAM?)" : `restarted (pid ${pid})`}. Its last log lines: ${tail}`
      );
    }
    for (const key of giveUp) {
      if (givenUp.has(key)) continue;
      givenUp.add(key);
      await log.error(`[Reloader] ${seen.get(key)?.filename} died ${MAX_REVIVALS_PER_HOUR} times within an hour; not restarting it again for now.`);
    }
    for (const p of running) {
      if (!p.args.includes("--once")) seen.set(daemonKey(p.filename, p.args), { filename: p.filename, threads: p.threads, args: p.args });
    }

    await runQueuedCommands(ns, log);

    await ns.asleep(CHECK_INTERVAL_MS);
  }
}
