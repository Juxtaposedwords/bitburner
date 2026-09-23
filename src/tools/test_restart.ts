import { NS } from "@ns";
import { pollWithBackoff } from "development/libraries/rpc";
import { collectAndWriteDump, DEFAULT_OUTPUT } from "tools/dump_logs";
import { wipeVarData } from "tools/wipe_data";

const BOOT_SCRIPT = "boot.js";
const BOOT_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 30_000;

/** How long to let the freshly-booted daemons run before capturing logs - long enough for a few scheduler/hacknet ticks, overridable via --settle <ms>. */
function parseSettleMs(rawArgs: (string | number | boolean)[]): number {
  const args = rawArgs.map(String);
  const index = args.indexOf("--settle");
  const next = args[index + 1];
  return index !== -1 && next !== undefined && !isNaN(Number(next)) ? Number(next) : DEFAULT_SETTLE_MS;
}

/**
 * Every host reachable from `home` by BFS over ns.scan - a raw network
 * walk, not a SupervisorService.ListServers RPC, deliberately: this tool
 * is about to kill supervisor.js itself, so it can't depend on that
 * service being alive (or its /var/supervisor/ state being trustworthy)
 * to know what to kill in the first place.
 */
function listAllHosts(ns: NS): string[] {
  const visited = new Set<string>();
  const queue = ["home"];

  while (queue.length > 0) {
    const host = queue.shift() as string;
    if (visited.has(host)) continue;
    visited.add(host);
    for (const neighbor of ns.scan(host)) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }

  return [...visited];
}

/**
 * One-shot "clean test cycle" orchestrator: kill everything, wipe runtime
 * data (configs under /etc/ survive - see wipe_data.ts), reboot, let it
 * settle, then dump every log to one file. Replaces the manual
 * killall / wipe_data.js / boot.js / wait / dump_logs.js sequence with a
 * single command.
 */
export async function main(ns: NS): Promise<void> {
  const settleMs = parseSettleMs(ns.args);
  const host = ns.getHostname();

  const allHosts = listAllHosts(ns);
  ns.tprint(`[TestRestart] Killing all scripts on ${allHosts.length} host(s)...`);
  for (const target of allHosts) {
    // safetyGuard only matters (and only needs to be true) on our own
    // host, so this orchestrator survives its own kill and can continue
    // with the remaining steps; harmless either way on every other host.
    ns.killall(target, target === host);
  }

  const removed = wipeVarData(ns, host);
  ns.tprint(`[TestRestart] Wiped ${removed} file(s) under /var/log/ and /var/supervisor/.`);

  ns.tprint(`[TestRestart] Launching ${BOOT_SCRIPT}...`);
  const pid = ns.run(BOOT_SCRIPT);
  if (pid === 0) {
    ns.tprint(`[TestRestart] ERROR: failed to launch ${BOOT_SCRIPT} (insufficient RAM?). Aborting.`);
    return;
  }

  const finished = await pollWithBackoff(ns, () => !ns.scriptRunning(BOOT_SCRIPT, host), Date.now() + BOOT_TIMEOUT_MS);
  if (!finished) {
    ns.tprint(`[TestRestart] WARNING: ${BOOT_SCRIPT} still running after ${BOOT_TIMEOUT_MS}ms; continuing anyway.`);
  }

  ns.tprint(`[TestRestart] Letting daemons run for ${(settleMs / 1000).toFixed(0)}s before capturing logs...`);
  await ns.asleep(settleMs);

  const fileCount = collectAndWriteDump(ns, host, Infinity, false, DEFAULT_OUTPUT);
  ns.tprint(
    fileCount === 0
      ? "[TestRestart] No log files found - something didn't start."
      : `[TestRestart] Wrote ${fileCount} file(s) to ${DEFAULT_OUTPUT}. Open it in the Script Editor and copy its contents (Ctrl+A, Ctrl+C).`
  );
}
