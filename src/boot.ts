import { NS } from "@ns";
import { EXPECTED_DAEMONS_PATH, readStoppedDaemons, STOPPED_DAEMONS_PATH } from "system/reload_plan";
import { CORE_SCRIPTS, FACTION_STACK, fullSystemFits, requiredHomeRam } from "system/bootstrap/plan";
import { bitNodeGrants, readBitNodeInfo } from "system/bitnode_info";
import { placeDaemon, pruneDaemonHosts } from "system/remote_place";
import { FACTIONS_SERVICE_SCRIPTS } from "factions/services/deploy";
import { daemonHosts } from "system/remote_state";
import * as rpc from "system/rpc/rpc";
import { sleevesAvailable } from "sleeves/sleeve_decisions";

const CAPABILITY_DETECTOR_SCRIPT = "system/detect_capabilities.js";
const PROGRAM_SHOPPER_SCRIPT = "hacking/program_shopper.js";
const BACKDOOR_SCRIPT = "hacking/backdoor_daemon.js";
const FACTION_SCRIPT = "factions/faction_daemon.js";
const STUDY_SCRIPT = "factions/study_daemon.js";
const GANG_SCRIPT = "gang/gang_daemon.js";
const SCHEDULER_SCRIPT = "hacking/scheduler_daemon.js";
const HACKNET_SCRIPT = "economy/hacknet_daemon.js";
const PURCHASED_SERVER_SCRIPT = "economy/purchased_server_daemon.js";
const STOCK_SCRIPT = "economy/stock_daemon.js";
const STOCK_TARGET_SCRIPT = "economy/stock_target_daemon.js";
const MONITORING_SCRIPT = "system/monitoring/monitoring_daemon.js";
const SHARE_SCRIPT = "hacking/share_daemon.js";
const GO_SCRIPT = "go/go_daemon.js";
const BOOTSTRAP_SCRIPT = "system/bootstrap/bootstrap.js";
const SLEEVE_KICK_SCRIPT = "system/bootstrap/bootstrap_sleeves.js";
const SLEEVE_SCRIPT = "sleeves/sleeve_daemon.js";
const SUPERVISOR_SCRIPT = "system/supervisor.js";
// The faction daemon's game calls, as services (docs/faction_split.md).
// The faction daemon's game calls, as small services (generated from
// faction_services.proto; docs/faction_split.md).
const FACTION_SERVICES = FACTIONS_SERVICE_SCRIPTS;
// Daemons boot may run off home while home is too small for them: on a
// hacked server with room, else DAEMON_HOST (system/remote_place.ts).
// The sleeve daemon too (64 GB): BN9 held it behind a full 128 GB home
// while rooted 128 GB servers stood by.
// And the gang daemon (32.5 GB), which creates the gang once karma allows.
// And the study daemon (25 GB), which BN9 held behind a full home.
const REMOTE_OK = [...FACTION_SERVICES, FACTION_SCRIPT, SLEEVE_SCRIPT, GANG_SCRIPT, STUDY_SCRIPT, STOCK_SCRIPT];

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
// reloader.js restarts any of the managed daemons when their code changes
// (see reload_plan.ts) - small, so it starts with the first daemons.
const DAEMONS = [
  "system/supervisor.js",
  "system/log_rotator.js",
  "system/player.js",
  "system/reloader.js",
  "hacking/network_daemon.js",
];

// network_daemon.js (above) roots, snapshots and ranks every 10s; nothing
// needs running once in order any more.
const ONE_SHOT: string[] = [];

const ONE_SHOT_TIMEOUT_MS = 60_000;

/** Launches `script` unless it's already running; true if it's running afterwards. */
const BOOTSTRAP_WORKER = "system/bootstrap/bootstrap_worker.js";

/** Every server reachable from home. */
function reachableHosts(ns: NS): string[] {
  const seen = new Set(["home"]);
  const queue = ["home"];
  while (queue.length > 0) {
    for (const next of ns.scan(queue.shift() as string)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** Kills `script` on every server reachable from home; returns how many servers had it. */
function killEverywhere(ns: NS, script: string): number {
  const seen = new Set(["home"]);
  const queue = ["home"];
  let killed = 0;
  while (queue.length > 0) {
    const host = queue.shift() as string;
    if (ns.scriptKill(script, host)) killed++;
    for (const next of ns.scan(host)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return killed;
}

function launchIfNotRunning(ns: NS, script: string): boolean {
  if (ns.scriptRunning(script)) {
    say(ns, `[Boot] ${script} already running, skipping.`);
    return true;
  }

  const pid = ns.run(script);
  say(ns, 
    pid === 0
      ? `[Boot] ERROR: failed to launch ${script} (insufficient RAM?).`
      : `[Boot] Launched ${script} (pid ${pid}).`
  );
  return pid !== 0;
}

async function launchAndWait(ns: NS, script: string, timeoutMs: number): Promise<void> {
  launchIfNotRunning(ns, script);

  const finished = await rpc.pollWithBackoff(ns, () => !ns.scriptRunning(script), Date.now() + timeoutMs);
  if (!finished) {
    say(ns, `[Boot] WARNING: ${script} still running after ${timeoutMs}ms; continuing anyway.`);
  }
}

// Boot's decisions, also recorded (the terminal isn't visible to tools):
// BN12's starts stalled twice in the bootstrap -> shopper -> boot chain
// with nothing to show why.
const BOOT_REPORT_PATH = "/var/claude_out/boot.txt";

/** ns.tprint, also recorded in BOOT_REPORT_PATH. */
function say(ns: NS, line: string): void {
  ns.tprint(line);
  ns.write(BOOT_REPORT_PATH, `[${new Date().toISOString()}] ${line}\n`, "a");
}

export async function main(ns: NS): Promise<void> {
  say(ns, `[Boot] Started: home ${ns.getServerMaxRam("home")} GB, ${(ns.getServerMaxRam("home") - ns.getServerUsedRam("home")).toFixed(1)} GB free.`);
  // The bootstrap hands off through `program_shopper.js --once`, which runs
  // this and then exits - but this starts while the shopper is still in
  // memory, and on a fresh 32 GB home system/bootstrap/bootstrap.js then didn't fit:
  // "failed to launch", and nothing was left running. Wait for it to exit.
  for (let i = 0; i < 50 && ns.isRunning(PROGRAM_SHOPPER_SCRIPT, "home", "--once"); i++) await ns.asleep(100);
  // Low-RAM startup: while home can't hold the full system's core
  // (bootstrap_plan.ts), run the self-contained system/bootstrap/bootstrap.js instead of
  // starting daemons that won't fit - it hands back to boot.js once home is
  // big enough. Only when the full system isn't already up: a boot re-run
  // after a RAM upgrade must not start bootstrap beside it (bootstrap stops
  // every worker on its servers).
  // RAM 0 means the game can't load the script (a missing file, or an
  // import its dependencies don't provide - e.g. files changed while the
  // game was closed never reached it). That's an error to fix, not a small
  // home: treating it as one once started bootstrap on a 16 TB home.
  const unloadable = CORE_SCRIPTS.filter((script) => !(ns.getScriptRam(script, "home") > 0));
  if (unloadable.length > 0) {
    say(ns, 
      `[Boot] ERROR: the game can't load ${unloadable.join(", ")} (RAM 0 - missing or out-of-date files). ` +
        "Let filesync push everything (or re-run the watch), then run boot.js again."
    );
    return;
  }
  const requiredRam = requiredHomeRam(CORE_SCRIPTS.map((script) => ns.getScriptRam(script, "home")));
  const homeRam = ns.getServerMaxRam("home");
  // The core plus room for the faction stack (on home, or hacked servers big
  // enough for its services) - the same test the bootstrap hands over on.
  // Not hacknet servers: RAM used there costs hashes.
  const hackedRams = reachableHosts(ns)
    .filter((h) => h !== "home" && !/^hacknet-(server|node)-\d+$/.test(h) && ns.hasRootAccess(h))
    .map((h) => ns.getServerMaxRam(h));
  const fits = fullSystemFits(homeRam, requiredRam, FACTION_STACK.map((script) => ns.getScriptRam(script, "home")), hackedRams);
  if (!fits && !ns.scriptRunning(SUPERVISOR_SCRIPT, "home")) {
    say(ns, `[Boot] Home has ${homeRam} GB and ${hackedRams.length} rooted hacked server(s); the full system (core ${requiredRam.toFixed(1)} GB plus the faction stack) doesn't pack onto them yet. Starting ${BOOTSTRAP_SCRIPT} instead.`);
    // Spawned, not run: the game ends this script first, so the bootstrap
    // (~27 GB) gets a fresh 32 GB home to itself rather than what's left
    // beside boot (~20 GB).
    if (!ns.scriptRunning(BOOTSTRAP_SCRIPT, "home")) {
      // Idle sleeves to a crime first - the bootstrap has no room to run
      // this one-shot beside itself on a 32 GB home.
      if (ns.fileExists(SLEEVE_KICK_SCRIPT, "home")) await launchAndWait(ns, SLEEVE_KICK_SCRIPT, ONE_SHOT_TIMEOUT_MS);
      ns.spawn(BOOTSTRAP_SCRIPT, { spawnDelay: 1000 });
    }
    return;
  }

  // Starting the full system: clear what a bootstrap left behind. Killing
  // system/bootstrap/bootstrap.js by hand leaves its workers filling every server - BN10's
  // second run had 16 TB of home taken by them, so the scheduler couldn't
  // start ("insufficient RAM").
  if (ns.scriptRunning(BOOTSTRAP_SCRIPT, "home")) ns.scriptKill(BOOTSTRAP_SCRIPT, "home");
  const killed = killEverywhere(ns, BOOTSTRAP_WORKER);
  if (killed > 0) say(ns, `[Boot] Stopped leftover ${BOOTSTRAP_WORKER} on ${killed} server(s).`);

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
  await launchAndWait(ns, CAPABILITY_DETECTOR_SCRIPT, ONE_SHOT_TIMEOUT_MS);

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
  // From the file detect_capabilities.js just wrote.
  const bitNode = readBitNodeInfo(ns);
  const singularity = bitNodeGrants(bitNode, 4);
  const gang = bitNodeGrants(bitNode, 2);
  const sleeves = sleevesAvailable(bitNode?.node, bitNode?.sourceFiles);
  const ordered: [string, boolean][] = [
    [SCHEDULER_SCRIPT, true],
    [PROGRAM_SHOPPER_SCRIPT, singularity],
    // Income, and small (12 GB): ahead of everything that only spends or
    // plans. In BitNode 9 the hacknet is the income (scripts' hacking pays
    // ~1/1000th) - its start was held behind a gang daemon that didn't fit,
    // then behind faction services filling a 128 GB home.
    [HACKNET_SCRIPT, true],
    // The services before the faction daemon, which only plans through them.
    ...FACTION_SERVICES.map((script): [string, boolean] => [script, singularity]),
    [FACTION_SCRIPT, singularity],
    // Sleeves before the gang daemon: they earn the karma it waits on.
    [SLEEVE_SCRIPT, sleeves],
    [GANG_SCRIPT, gang],
    [STUDY_SCRIPT, singularity],
    // The gauges and run milestones every evaluation reads - ahead of the
    // optional economy daemons.
    [MONITORING_SCRIPT, true],
    [BACKDOOR_SCRIPT, singularity],
    [STOCK_SCRIPT, true],
    [STOCK_TARGET_SCRIPT, true],
    // Nothing to do where the BitNode allows no purchased servers (BN9).
    [PURCHASED_SERVER_SCRIPT, (bitNode?.multipliers?.CloudServerLimit ?? 1) > 0],
    [SHARE_SCRIPT, true],
    [GO_SCRIPT, true],
  ];
  // Strict priority: once one doesn't fit, nothing after it is launched -
  // a smaller, lower-priority daemon would otherwise take RAM the one that
  // didn't fit needs (in BN10 the backdoor daemon took the program
  // shopper's RAM, so nothing bought RAM or programs). The program shopper
  // re-runs boot after each home RAM upgrade, which picks up from here.
  const started = [...DAEMONS];
  // Hosts whose daemons are gone (an install ends every script) go back to the workers.
  pruneDaemonHosts(ns);
  // Stopped on purpose (tools/kill.js): left down, not restarted - and
  // not holding up the rest.
  const stoppedOnPurpose = readStoppedDaemons(ns.read(STOPPED_DAEMONS_PATH));
  for (const [script, available] of ordered) {
    if (!available) continue;
    if (stoppedOnPurpose.includes(script)) {
      say(ns, `[Boot] ${script} was stopped on purpose (tools/kill.js); leaving it.`);
      continue;
    }
    // Too big for home yet: on another server instead (system/remote_place.ts)
    // - so the rest of the order still starts. BN12's third run had the
    // ~100 GB faction daemon wait 38 minutes for a $7.9M server; split into
    // services of 32 GB or less, it fits early hacked servers.
    // Already running, here or there: never a second copy (two faction
    // daemons would both act; two services would share one port).
    const runningOn = REMOTE_OK.includes(script) ? ["home", ...daemonHosts(ns)].find((host) => ns.serverExists(host) && ns.isRunning(script, host)) : undefined;
    if (runningOn) {
      say(ns, `[Boot] ${script} already running on ${runningOn}, skipping.`);
      started.push(script);
      continue;
    }
    // A daemon that can run anywhere goes on a hacked server first, so
    // home's room is left for the daemons that can only run there (BN9: the
    // faction services filled home, then monitoring had nowhere to go).
    // Home is its fallback; a purchased server (daemons-0) only when home
    // is full too.
    if (REMOTE_OK.includes(script)) {
      const homeFull = ns.args.includes("--place-remote") || ns.getScriptRam(script, "home") > ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
      if (placeDaemon(ns, script, (line) => say(ns, `[Boot] ${line}`), homeFull)) {
        started.push(script);
        continue;
      }
    }
    if (!launchIfNotRunning(ns, script)) {
      say(ns, `[Boot] Holding off on everything after ${script} until home has more RAM.`);
      break;
    }
    started.push(script);
  }
  // For the reloader: revive these whenever they're missing, even after a
  // game restart it never saw them through (EXPECTED_DAEMONS_PATH).
  // Every daemon this boot should have running, including those held for
  // room: the reloader keeps trying them, and re-runs boot to place them on
  // other servers. Only what started used to be listed - after BN9's 23:28
  // restart the hacknet daemon (its income) stayed down for 2.5 hours.
  const expected = [...new Set([...started, ...ordered.filter(([, available]) => available).map(([script]) => script)])];
  ns.write(EXPECTED_DAEMONS_PATH, JSON.stringify({ daemons: expected, writtenAt: Date.now() }), "w");
}
