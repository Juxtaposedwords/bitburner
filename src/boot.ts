import { NS } from "@ns";
import * as rpc from "development/libraries/rpc";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

const CAPABILITY_DETECTOR_SCRIPT = "development/metadata/detect_capabilities.js";
const PROGRAM_SHOPPER_SCRIPT = "tools/program_shopper.js";
const BACKDOOR_SCRIPT = "development/metadata/backdoor_daemon.js";
const FACTION_SCRIPT = "development/metadata/faction_daemon.js";
const STUDY_SCRIPT = "development/metadata/study_daemon.js";
const GANG_SCRIPT = "development/metadata/gang_daemon.js";
const SCHEDULER_SCRIPT = "development/metadata/scheduler_daemon.js";
const HACKNET_SCRIPT = "development/metadata/hacknet_daemon.js";
const PURCHASED_SERVER_SCRIPT = "development/metadata/purchased_server_daemon.js";
const STOCK_SCRIPT = "development/metadata/stock_daemon.js";
const STOCK_TARGET_SCRIPT = "development/metadata/stock_target_daemon.js";
const MONITORING_SCRIPT = "development/metadata/monitoring_daemon.js";
const SHARE_SCRIPT = "development/metadata/share_daemon.js";

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

  // Runs every boot. It used to be skipped once supervisor had cached
  // singularity/gang availability, on the reasoning that Source-Files never
  // change mid-session - but entering a new BitNode is exactly when they
  // (and the BitNode multipliers it now records to /var/bitnode/current.txt,
  // see bitnode_info.ts) do change, and nothing re-checked then. A one-shot
  // ~1 GB getResetInfo (plus getBitNodeMultipliers with SF5) per boot is
  // cheap. Supervisor is guaranteed reachable here: the ONE_SHOT loop above
  // already RPC'd it successfully.
  const playerClient = player_metadata_pb.NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort);
  await launchAndWait(ns, CAPABILITY_DETECTOR_SCRIPT, ONE_SHOT_TIMEOUT_MS);
  const playerRes = await playerClient.GetPlayerMetadata({});

  // Launched in priority order, because in a fresh BitNode home is small
  // and whatever comes last simply doesn't fit ("insufficient RAM?"). The
  // first BN10 boot started study/backdoor ahead of the scheduler, so
  // nothing earned money - and the study daemon, still on BN9's GROW_STATS,
  // put the player in a paid class at ~$1,000 cash.
  //
  // 1. Income and access first: the scheduler (everything it needs - a
  //    rooted network, a ranked target - is done by now) and the program
  //    shopper (port openers mean more rooted servers to run on).
  // 2. Then progression: factions and, with Source-File 2, the gang.
  // 3. Then optional growth and tooling, cheapest-value last. The daemons
  //    here have no dependencies; the stock ones are tiny processes kept
  //    apart so ns.stock.* never grows the scheduler's footprint (see
  //    server_metadata.md). Anything that didn't fit can be started by
  //    re-running boot.js once home has more RAM.
  const singularity = playerRes.data?.player?.singularityAvailable === true;
  const gang = playerRes.data?.player?.gangAvailable === true;
  const ordered: [string, boolean][] = [
    [SCHEDULER_SCRIPT, true],
    [PROGRAM_SHOPPER_SCRIPT, singularity],
    [FACTION_SCRIPT, singularity],
    [GANG_SCRIPT, gang],
    [HACKNET_SCRIPT, true],
    [STUDY_SCRIPT, singularity],
    [BACKDOOR_SCRIPT, singularity],
    [STOCK_SCRIPT, true],
    [STOCK_TARGET_SCRIPT, true],
    [PURCHASED_SERVER_SCRIPT, true],
    [MONITORING_SCRIPT, true],
    [SHARE_SCRIPT, true],
  ];
  for (const [script, available] of ordered) {
    if (available) launchIfNotRunning(ns, script);
  }
}
