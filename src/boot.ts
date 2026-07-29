import { NS } from "@ns";
import * as rpc from "development/libraries/rpc";

// Long-running daemons. Idempotent launch matters here specifically for
// supervisor.js: it owns a single RPC port, so a duplicate instance would
// race with the first to read/reply on it.
const DAEMONS = ["development/metadata/supervisor.js", "tools/log_rotator.js", "development/metadata/player.js"];

// Run once and exit, in order — each one is a prerequisite for the next, not
// just "launched earlier": target_selector.js needs crawl_servers.js to have
// actually *finished* populating supervisor, not merely started, or it can
// compute weights over an empty/partial server list. Launched after the
// daemons above so supervisor is already starting up by the time the first
// one tries to RPC it.
const ONE_SHOT = ["development/metadata/crawl_servers.js", "development/metadata/target_selector.js"];

const ONE_SHOT_TIMEOUT_MS = 60_000;

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

async function launchAndWait(ns: NS, script: string, timeoutMs: number): Promise<void> {
  launchIfNotRunning(ns, script);

  const finished = await rpc.pollWithBackoff(ns, () => !ns.scriptRunning(script), Date.now() + timeoutMs);
  if (!finished) {
    ns.tprint(`[Boot] WARNING: ${script} still running after ${timeoutMs}ms; continuing anyway.`);
  }
}

export async function main(ns: NS): Promise<void> {
  for (const script of DAEMONS) {
    launchIfNotRunning(ns, script);
  }

  for (const script of ONE_SHOT) {
    await launchAndWait(ns, script, ONE_SHOT_TIMEOUT_MS);
  }
}
