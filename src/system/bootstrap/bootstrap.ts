import { NS } from "@ns";
import {
  CORE_SCRIPTS,
  FACTION_STACK,
  hashIncomePerSec,
  SEED_INCOME_PER_SEC,
  fullSystemFits,
  HACKNET_SPEND_FRACTION,
  HacknetOption,
  playerActivity,
  pickHacknetPurchase,
  pickBootstrapTarget,
  requiredHomeRam,
  shouldHandOffToShopper,
  workerThreads,
} from "system/bootstrap/plan";
import { COMMANDS_DONE_PATH, COMMANDS_PATH, pendingCommands } from "system/reload_plan";

/**
 * Low-RAM startup: a self-contained stand-in for the full system while home
 * can't run it yet (fullSystemFits: the core plus room for the faction
 * stack). boot.ts spawns this instead of everything else then.
 *
 * No supervisor, RPC, generated code, or config - direct calls only, so it
 * fits a fresh BitNode's 32 GB home. Every tick it:
 * 1. keeps the player busy (playerActivity): the free Computer Science
 *    course - or, in BitNode 9 while the hacknet earns little, a crime for
 *    the money hacking can't make there;
 * 2. in BitNode 9, sells every hash and buys the cheapest hacknet upgrades
 *    (runHacknet) - hashes are that BitNode's income;
 * 3. roots every server the owned port openers allow, and runs
 *    bootstrap_worker.js on them against one early target
 *    (pickBootstrapTarget);
 * 4. once cash covers something worth buying (shouldHandOffToShopper),
 *    spawns the program shopper for one pass (`--once`: it buys, then runs
 *    boot.js) - spawned, so it gets this script's RAM;
 * 5. once the full system fits, spawns boot.js (unless `--hold`, which
 *    keeps it here for testing on a big home);
 * 6. runs the Claude command queue (the reloader isn't running), and
 *    restarts through boot.js when its own code changes.
 */
const WORKER = "system/bootstrap/bootstrap_worker.js";
const SHOPPER = "hacking/program_shopper.js";
const BOOT = "boot.js";
const HOME = "home";
// Free, in Sector-12 (where every BitNode starts); it continues on its own.
const UNIVERSITY = "Rothman University";
const COURSE = "Computer Science";
const TICK_MS = 10_000;
const STATUS_FILE = "/var/bootstrap_status.txt";

const OPENERS: [string, (ns: NS, host: string) => void][] = [
  ["BruteSSH.exe", (ns, host) => ns.brutessh(host)],
  ["FTPCrack.exe", (ns, host) => ns.ftpcrack(host)],
  ["relaySMTP.exe", (ns, host) => ns.relaysmtp(host)],
  ["HTTPWorm.exe", (ns, host) => ns.httpworm(host)],
  ["SQLInject.exe", (ns, host) => ns.sqlinject(host)],
];

type UniversityName = Parameters<NS["singularity"]["universityCourse"]>[0];
type CrimeName = Parameters<NS["singularity"]["commitCrime"]>[0];
// Money for the first hacknet server (needSeedMoney).
const SEED_CRIME = "Mug";
type CourseName = Parameters<NS["singularity"]["universityCourse"]>[1];
type ProgramName = Parameters<NS["singularity"]["purchaseProgram"]>[0];

/**
 * Every server reachable from home, minus Hacknet servers: they reject
 * getServerMaxMoney ("must not be a hacknet server"), can't be hacked, and
 * RAM used on them lowers their hash production - the full scheduler
 * skips them too. Their names come from the Hacknet API, not a guess.
 */
function allServers(ns: NS): string[] {
  const hacknet = new Set(Array.from({ length: ns.hacknet.numNodes() }, (_, i) => ns.hacknet.getNodeStats(i).name));
  const seen = new Set([HOME]);
  const queue = [HOME];
  while (queue.length > 0) {
    for (const next of ns.scan(queue.shift() as string)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].filter((host) => !hacknet.has(host));
}

function rootAll(ns: NS, hosts: string[]): void {
  const owned = OPENERS.filter(([program]) => ns.fileExists(program, HOME));
  for (const host of hosts) {
    if (host === HOME || ns.hasRootAccess(host)) continue;
    if (ns.getServerNumPortsRequired(host) > owned.length) continue;
    for (const [, open] of owned) open(ns, host);
    ns.nuke(host);
  }
}

/** Whether cash now covers something worth a shopper pass (shouldHandOffToShopper). */
function readyToShop(ns: NS): boolean {
  return shouldHandOffToShopper(
    ns.getServerMoneyAvailable(HOME),
    ns.hasTorRouter(),
    OPENERS.map(([program]) => ns.singularity.getDarkwebProgramCost(program as ProgramName)),
    ns.singularity.getUpgradeHomeRamCost()
  );
}

/** Starts workers in all free RAM; returns the worker threads now running across `hosts`. */
function deploy(ns: NS, hosts: string[], target: string, workerRam: number, homeKeepGb: number): number {
  for (const host of hosts) {
    if (!ns.hasRootAccess(host)) continue;
    const keep = host === HOME ? homeKeepGb : 0;
    const threads = workerThreads(ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - keep, workerRam);
    if (threads === 0) continue;
    if (host !== HOME) ns.scp(WORKER, host, HOME);
    ns.exec(WORKER, host, threads, target, Date.now());
  }
  return countWorkerThreads(ns, hosts);
}

/** Worker threads running across `hosts` (ns.ps). */
function countWorkerThreads(ns: NS, hosts: string[]): number {
  let threads = 0;
  for (const host of hosts) for (const p of ns.ps(host)) if (p.filename === WORKER) threads += p.threads;
  return threads;
}

function stopWorkers(ns: NS, hosts: string[]): void {
  for (const host of hosts) {
    if (host === HOME) ns.scriptKill(WORKER, HOME);
    else if (ns.hasRootAccess(host)) ns.killall(host);
  }
}

const SELL_FOR_MONEY = "Sell for Money";
// Purchases per tick at most, so a tick stays short.
const HACKNET_BUYS_PER_TICK = 20;

/**
 * BitNode 9: sells every hash for cash, then buys the cheapest hacknet
 * improvements (pickHacknetPurchase). Returns what it did, for the status line.
 */
function runHacknet(ns: NS): string {
  let sold = 0;
  while (ns.hacknet.numHashes() >= ns.hacknet.hashCost(SELL_FOR_MONEY) && ns.hacknet.spendHashes(SELL_FOR_MONEY)) sold++;
  let bought = 0;
  for (let i = 0; i < HACKNET_BUYS_PER_TICK; i++) {
    const options: HacknetOption[] = [{ kind: "server", index: -1, cost: ns.hacknet.getPurchaseNodeCost() }];
    for (let n = 0; n < ns.hacknet.numNodes(); n++) {
      options.push(
        { kind: "level", index: n, cost: ns.hacknet.getLevelUpgradeCost(n, 1) },
        { kind: "ram", index: n, cost: ns.hacknet.getRamUpgradeCost(n, 1) },
        { kind: "core", index: n, cost: ns.hacknet.getCoreUpgradeCost(n, 1) }
      );
    }
    const pick = pickHacknetPurchase(options, ns.getServerMoneyAvailable(HOME), HACKNET_SPEND_FRACTION);
    if (!pick) break;
    const ok =
      pick.kind === "server"
        ? ns.hacknet.purchaseNode() >= 0
        : pick.kind === "level"
          ? ns.hacknet.upgradeLevel(pick.index, 1)
          : pick.kind === "ram"
            ? ns.hacknet.upgradeRam(pick.index, 1)
            : ns.hacknet.upgradeCore(pick.index, 1);
    if (!ok) break;
    bought++;
  }
  return ` hacknet=${ns.hacknet.numNodes()} sold=${sold} bought=${bought}`;
}

// Tries at starting one queued command before giving up on it.
const MAX_COMMAND_TRIES = 6;
const commandTries = new Map<string, number>();

/**
 * The Claude command queue, as the reloader runs it (it doesn't run in
 * bootstrap mode, so queued tools waited until the full system started).
 */
function runCommandQueue(ns: NS): void {
  const done = new Set<string>((ns.read(COMMANDS_DONE_PATH) || "").split("\n").filter(Boolean));
  for (const { command, allowed } of pendingCommands(ns.read(COMMANDS_PATH), done)) {
    const tries = (commandTries.get(command.id) ?? 0) + 1;
    commandTries.set(command.id, tries);
    const ran = allowed && ns.run(command.script, 1, ...(command.args ?? [])) !== 0;
    if (ran || tries >= MAX_COMMAND_TRIES) {
      done.add(command.id);
      ns.write(COMMANDS_DONE_PATH, [...done].join("\n"), "w");
    }
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // BitNode 9 earns through hacknet servers (runHacknet), not hacking.
  const hacknetIncome = ns.getResetInfo().currentNode === 9;
  const workerRam = ns.getScriptRam(WORKER, HOME);
  // Leave room on home to run boot.js at handoff.
  const homeKeepGb = ns.getScriptRam(BOOT, HOME);
  let target: string | undefined;
  // Testing on a big home: stay in bootstrap mode even once the full system fits.
  const hold = ns.args.includes("--hold");

  // The reloader doesn't run in bootstrap mode, so new code never applied
  // until someone restarted this by hand (BN9, several times): when this
  // file changes, hand over to boot.js, which starts the new version.
  const ownCode = ns.read(ns.getScriptName());
  while (true) {
    if (ns.read(ns.getScriptName()) !== ownCode) {
      ns.tprint(`[Bootstrap] ${ns.getScriptName()} changed; restarting through ${BOOT}.`);
      ns.spawn(BOOT, { spawnDelay: 500 });
      return;
    }
    const required = requiredHomeRam(CORE_SCRIPTS.map((script) => ns.getScriptRam(script, HOME)));
    const hosts = allServers(ns);

    const hackedRams = hosts.filter((h) => h !== HOME && ns.hasRootAccess(h)).map((h) => ns.getServerMaxRam(h));
    const stackRams = FACTION_STACK.map((script) => ns.getScriptRam(script, HOME));
    if (!hold && fullSystemFits(ns.getServerMaxRam(HOME), required, stackRams, hackedRams)) {
      ns.tprint(`[Bootstrap] Home has ${ns.getServerMaxRam(HOME)} GB, and the faction services pack onto it and ${hackedRams.length} hacked server(s); handing over to ${BOOT}.`);
      stopWorkers(ns, hosts);
      ns.spawn(BOOT, { spawnDelay: 500 });
      return;
    }

    // Idle, or on a crime (an older bootstrap's Mug): to the course. Other
    // work - someone doing something by hand - is left alone.
    // Money first where the hacknet is the income and there's none yet to
    // earn with (an install wipes it): a crime until the first server is
    // affordable - study earns nothing, hacking ~nothing there.
    const work = ns.singularity.getCurrentWork();
    // Crime until the hacknet out-earns it (SEED_INCOME_PER_SEC): its first
    // servers make a few hundred $/s, while study makes nothing.
    const hashRate = Array.from({ length: ns.hacknet.numNodes() }, (_, i) => ns.hacknet.getNodeStats(i).production).reduce((a, b) => a + b, 0);
    const hashIncome = hashIncomePerSec(hashRate, ns.hacknet.hashCost(SELL_FOR_MONEY));
    const activity = playerActivity(hacknetIncome, hashIncome, work?.type);
    if (activity === "crime") ns.singularity.commitCrime(SEED_CRIME as CrimeName, false);
    else if (activity === "study") ns.singularity.universityCourse(UNIVERSITY as UniversityName, COURSE as CourseName, false);
    const needSeedMoney = hacknetIncome && hashIncome < SEED_INCOME_PER_SEC;
    rootAll(ns, hosts);

    if (readyToShop(ns)) {
      // Spawned, so the shopper gets this script's RAM: run beside it (26.55
      // + 12.15 GB) it never fit a fresh 32 GB home, and nothing was bought.
      // The course or crime keeps going on its own; the shopper runs boot.js.
      stopWorkers(ns, hosts);
      ns.write(STATUS_FILE, `[Bootstrap] ${new Date().toLocaleTimeString()} handing off to ${SHOPPER} --once (it runs boot.js when done)\n`, "w");
      ns.spawn(SHOPPER, { spawnDelay: 500 }, "--once");
      return;
    }
    runCommandQueue(ns);

    const next = pickBootstrapTarget(
      hosts.map((host) => ({
        host,
        maxMoney: ns.getServerMaxMoney(host),
        requiredHackingLevel: ns.getServerRequiredHackingLevel(host),
        hasRoot: ns.hasRootAccess(host),
      })),
      ns.getHackingLevel(),
      target
    );
    if (next && next !== target) {
      // New target: restart every worker on it.
      stopWorkers(ns, hosts);
      target = next;
      ns.print(`[Bootstrap] Target: ${target}.`);
    }
    const threads = target ? deploy(ns, hosts, target, workerRam, homeKeepGb) : 0;
    const hacknet = hacknetIncome ? `${runHacknet(ns)} hashIncome=$${hashIncome.toFixed(0)}/s ${needSeedMoney ? "crime" : "study"}` : "";

    // One status line per tick (ns.print is free) - `tail system/bootstrap/bootstrap.js`.
    const rooted = hosts.filter((host) => ns.hasRootAccess(host)).length;
    const line =
      `money=$${ns.getServerMoneyAvailable(HOME).toFixed(0)} hacking=${ns.getHackingLevel()} ` +
      `home=${ns.getServerMaxRam(HOME)}/${required.toFixed(0)} GB rooted=${rooted}/${hosts.length} ` +
      `target=${target ?? "none"} workerThreads=${threads} tor=${ns.hasTorRouter()}${hacknet}`;
    ns.print(line);
    // Also as a file (ns.write is free): `cat /var/bootstrap_status.txt`
    // works while home has no room for tools/status.js.
    ns.write(STATUS_FILE, `[Bootstrap] ${new Date().toLocaleTimeString()} ${line}\n`, "w");

    await ns.asleep(TICK_MS);
  }
}
