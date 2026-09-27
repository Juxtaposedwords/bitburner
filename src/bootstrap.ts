import { NS } from "@ns";
import {
  CORE_SCRIPTS,
  pickBootstrapTarget,
  requiredHomeRam,
  shouldHandOffToShopper,
  workerThreads,
} from "development/libraries/bootstrap_plan";

/**
 * Low-RAM startup: a self-contained stand-in for the full system while home
 * is too small to hold its core (see bootstrap_plan.ts). boot.ts runs this
 * instead of everything else when home RAM is below requiredHomeRam.
 *
 * No supervisor, RPC, generated code, or config - direct calls only, so it
 * fits a fresh BitNode's home with room for workers. Every tick it:
 * 1. commits a crime while the player is idle (money; the only income that
 *    works at hacking level ~1),
 * 2. roots every server the owned port openers allow,
 * 3. runs bootstrap_worker.js on every rooted server and spare home RAM
 *    against the best early target (pickBootstrapTarget),
 * 4. once cash covers something worth buying (TOR, a port opener, the next
 *    home RAM upgrade - shouldHandOffToShopper), stops its workers, runs
 *    the program shopper for one pass (`--once`: it buys everything it
 *    can, then runs boot.js), and exits. The purchase calls live only in
 *    the shopper, saving 7 GB here for workers; boot.js then picks
 *    bootstrap again, or the full system once home is big enough.
 * 5. once home fits the full system, stops its workers, runs boot.js, and
 *    exits.
 */
const WORKER = "bootstrap_worker.js";
const SHOPPER = "tools/program_shopper.js";
const BOOT = "boot.js";
const HOME = "home";
// Reliable early money at low combat stats; it repeats on its own.
const CRIME = "Mug";
const TICK_MS = 10_000;

const OPENERS: [string, (ns: NS, host: string) => void][] = [
  ["BruteSSH.exe", (ns, host) => ns.brutessh(host)],
  ["FTPCrack.exe", (ns, host) => ns.ftpcrack(host)],
  ["relaySMTP.exe", (ns, host) => ns.relaysmtp(host)],
  ["HTTPWorm.exe", (ns, host) => ns.httpworm(host)],
  ["SQLInject.exe", (ns, host) => ns.sqlinject(host)],
];

type CrimeName = Parameters<NS["singularity"]["commitCrime"]>[0];
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

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const workerRam = ns.getScriptRam(WORKER, HOME);
  // Leave room on home to run boot.js at handoff.
  const homeKeepGb = ns.getScriptRam(BOOT, HOME);
  let target: string | undefined;

  while (true) {
    const required = requiredHomeRam(CORE_SCRIPTS.map((script) => ns.getScriptRam(script, HOME)));
    const hosts = allServers(ns);

    if (ns.getServerMaxRam(HOME) >= required) {
      ns.tprint(`[Bootstrap] Home has ${ns.getServerMaxRam(HOME)} GB (full system needs ${required.toFixed(1)}); handing over to ${BOOT}.`);
      stopWorkers(ns, hosts);
      ns.run(BOOT);
      return;
    }

    if (!ns.singularity.isBusy()) ns.singularity.commitCrime(CRIME as CrimeName);
    rootAll(ns, hosts);

    if (readyToShop(ns)) {
      // The crime keeps going on its own; the shopper runs boot.js when done.
      stopWorkers(ns, hosts);
      ns.run(SHOPPER, 1, "--once");
      return;
    }

    const next = pickBootstrapTarget(
      hosts.map((host) => ({
        host,
        maxMoney: ns.getServerMaxMoney(host),
        requiredHackingLevel: ns.getServerRequiredHackingLevel(host),
        hasRoot: ns.hasRootAccess(host),
      })),
      ns.getHackingLevel()
    );
    if (next && next !== target) {
      // New target: restart every worker on it.
      stopWorkers(ns, hosts);
      target = next;
      ns.print(`[Bootstrap] Target: ${target}.`);
    }
    const threads = target ? deploy(ns, hosts, target, workerRam, homeKeepGb) : 0;

    // One status line per tick (ns.print is free) - `tail bootstrap.js`.
    const rooted = hosts.filter((host) => ns.hasRootAccess(host)).length;
    ns.print(
      `money=$${ns.getServerMoneyAvailable(HOME).toFixed(0)} hacking=${ns.getHackingLevel()} ` +
        `home=${ns.getServerMaxRam(HOME)}/${required.toFixed(0)} GB rooted=${rooted}/${hosts.length} ` +
        `target=${target ?? "none"} workerThreads=${threads} tor=${ns.hasTorRouter()}`
    );

    await ns.asleep(TICK_MS);
  }
}
