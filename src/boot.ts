import { NS } from "@ns";
import * as rpc from "development/libraries/rpc";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

const CAPABILITY_DETECTOR_SCRIPT = "development/metadata/detect_capabilities.js";
const PROGRAM_SHOPPER_SCRIPT = "tools/program_shopper.js";
const SCHEDULER_SCRIPT = "development/metadata/scheduler_daemon.js";

// Long-running daemons. Idempotent launch matters here specifically for
// supervisor.js: it owns a single RPC port, so a duplicate instance would
// race with the first to read/reply on it.
//
// scheduler_daemon.js is deliberately NOT here despite being long-running:
// at ~8.6 GB (dominated by the *Analyze* functions its batch math needs)
// it's easily the most expensive thing this project launches on home. If it
// grabbed RAM in this eager, unordered batch, it could starve
// crawl_servers.js/rooter.js below of the RAM they need to launch at all on
// a RAM-constrained home server — breaking the entire rooting pipeline, not
// just delaying the scheduler. It's launched last (see main()), after every
// bootstrap-critical one-shot script has already had priority access to
// whatever RAM home actually has.
const DAEMONS = ["development/metadata/supervisor.js", "tools/log_rotator.js", "development/metadata/player.js"];

// Run once and exit, in order — each one is a prerequisite for the next, not
// just "launched earlier": rooter.js needs crawl_servers.js to have
// actually *finished* populating supervisor (so it has UNROOTABLE/ROOTABLE
// facts to act on), and target_selector.js needs rooter.js to have finished
// too, so a first boot doesn't rank purely off whatever was already rooted
// from a previous session. Supervisor's own dispatch background task (see
// dispatch.ts) can't cover this cold-start case on its own — it only fires
// on a *change* from a previous reading, and there is no previous reading
// yet at boot. Launched after the daemons above so supervisor is already
// starting up by the time the first one tries to RPC it.
const ONE_SHOT = [
  "development/metadata/crawl_servers.js",
  "development/metadata/rooter.js",
  "development/metadata/target_selector.js",
];

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

  // Source-File 4 / Singularity availability never changes mid-session (see
  // server_metadata.md), so once supervisor already has it — persisted
  // across restarts via state.player, not just this process's memory —
  // there's no need to pay ns.getResetInfo()'s cost again by re-running
  // detect_capabilities.js. Supervisor is guaranteed reachable here: the
  // ONE_SHOT loop above already RPC'd it successfully.
  const playerClient = player_metadata_pb.NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort);
  let playerRes = await playerClient.GetPlayerMetadata({});
  if (playerRes.data?.player?.singularityAvailable === undefined) {
    await launchAndWait(ns, CAPABILITY_DETECTOR_SCRIPT, ONE_SHOT_TIMEOUT_MS);
    playerRes = await playerClient.GetPlayerMetadata({});
  }

  if (playerRes.data?.player?.singularityAvailable) {
    launchIfNotRunning(ns, PROGRAM_SHOPPER_SCRIPT);
  }

  // Last: everything it depends on (a rooted network, a ranked target) is
  // already up by this point, and it's no longer competing with anything
  // else for home's RAM.
  launchIfNotRunning(ns, SCHEDULER_SCRIPT);
}
