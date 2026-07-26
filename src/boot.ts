import { NS } from "@ns";

// Long-running daemons. Idempotent launch matters here specifically for
// supervisor.js: it owns a single RPC port, so a duplicate instance would
// race with the first to read/reply on it.
const DAEMONS = ["development/metadata/supervisor.js", "tools/log_rotator.js", "development/metadata/player.js"];

// Runs once and exits — primes/refreshes supervisor's cache on every boot.
// Not a recurring job; re-run boot.js (or crawl_servers.js directly) if you
// want a fresher snapshot mid-session. Launched after the daemons above so
// supervisor is already starting up by the time it tries to RPC it.
const ONE_SHOT = ["development/metadata/crawl_servers.js"];

function launchIfNotRunning(ns: NS, script: string): void {
  if (ns.scriptRunning(script)) {
    ns.tprint(`[Boot] ${script} already running, skipping.`);
    return;
  }

  const pid = ns.run(script);
  ns.tprint(
    pid === 0
      ? `[Boot] ERROR: failed to launch ${script} (insufficient RAM?).`
      : `[Boot] Launched ${script} (pid ${pid}).`
  );
}

export async function main(ns: NS): Promise<void> {
  for (const script of DAEMONS) {
    launchIfNotRunning(ns, script);
  }

  for (const script of ONE_SHOT) {
    launchIfNotRunning(ns, script);
  }
}
