import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { scanWithPaths } from "development/libraries/network";
import * as server_metadata_pb from "development/metadata/server_metadata";

const CONFIG_PATH = "/etc/target_selector.txt";

export type TargetSelectorConfig = { weightsPath: string };

// Not supervisor's own data (it neither reads nor writes this), so it lives
// under its own directory rather than alongside supervisor's files.
const DEFAULT_CONFIG: TargetSelectorConfig = {
  weightsPath: "/var/target_selector/weights.txt",
};

export function loadConfig(ns: NS): TargetSelectorConfig {
  return loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
}

export type WeightedServer = { hostname: string; weight: number };

export type WeightsFile = {
  hackingLevel: number;
  computedAt: number;
  weights: WeightedServer[];
  // Which scoring produced this file (SCORER_VERSION) - so tools/status.js
  // can show whether a fresh ranking came from the latest code.
  scorer?: string;
  // Per server: max money, hack chance at min security, prep discount -
  // the factors behind each weight, for diagnosing a bad ranking.
  factors?: Record<string, { maxMoney: number; chance: number; discount: number }>;
};

// Bump with any scoring change.
export const SCORER_VERSION = "money-chanceAtMin-smoothPrep-roots-v4";

/**
 * $/sec proxy: more money and lower security both make a target more
 * attractive. Placeholder heuristic, swappable once real HWGW timing math
 * exists to compute actual $/sec.
 */
export function weightOf(server: server_metadata_pb.Metadata): number {
  return (server.maxMoney ?? 0) / Math.max(server.minSecurityLevel ?? 1, 1);
}

// After the first weaken (at current security), the grow and weaken rounds
// run at min security - roughly this many min-security weaken times.
const PREP_ROUNDS_AT_MIN = 2;
// The stretch a target should pay off over - about the time between installs.
const PREP_HORIZON_MS = 30 * 60_000;

/**
 * How much a prep of `prepMs` discounts a target: horizon / (horizon +
 * prep) - 1 for a prepped server, falling smoothly, never 0. A version
 * that hit 0 once the prep filled the horizon ranked every big server
 * (ecorp at security 99 after an install: ~10+ min per weaken) last, so
 * none was ever prepped and none ever ranked higher - a chicken-and-egg
 * that kept BN10 batching $1-5B servers at hacking 6871.
 */
export function prepDiscount(prepMs: number, horizonMs: number): number {
  if (!(horizonMs > 0) || !(prepMs > 0)) return 1;
  return horizonMs / (horizonMs + prepMs);
}

/**
 * Weights, best first. With `rateOf` (from the live game: hack chance,
 * discounted for prep - prepDiscount) a server's weight is maxMoney x
 * that; else the static weightOf.
 *
 * Batches fire about once a second whatever the target, and a big fleet
 * keeps many in flight, so a prepped server earns in proportion to its
 * money - weaken time only matters for the one-time prep. Ranking by
 * maxMoney/minSecurity ignored prep: after an install (every server back
 * at its starting security) it sent the scheduler to ecorp/megacorp, whose
 * prep outlasted the time to the next install. Ranking by money per weaken
 * time then overcorrected to foodnstuff ($50M): 128 TB idle at $1.8B/min.
 */
export function computeWeights(servers: server_metadata_pb.Metadata[], rateOf?: (host: string) => number | undefined): WeightedServer[] {
  return servers
    .filter((server): server is server_metadata_pb.Metadata & { hostname: string } => !!server.hostname)
    .map((server) => {
      const rate = rateOf?.(server.hostname);
      return { hostname: server.hostname, weight: rate !== undefined ? (server.maxMoney ?? 0) * rate : weightOf(server) };
    })
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Hacking level is the one thing this function itself can check without
 * outside input. It's not the only thing that can make weights stale
 * though — a server getting newly rooted can too, but that can't be
 * detected from a stored hacking level alone, so dispatch.ts's rooter
 * trigger bypasses this check entirely via FORCE_ARG rather than teaching
 * this function about a second, unrelated signal.
 */
export function shouldRecompute(storedHackingLevel: number | undefined, currentHackingLevel: number): boolean {
  return storedHackingLevel !== currentHackingLevel;
}

export function readWeightsFile(ns: NS, path: string): WeightsFile | undefined {
  const raw = ns.read(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as WeightsFile;
  } catch {
    return undefined;
  }
}

/**
 * A one-time job, not a daemon: computes weights once and exits. Triggered
 * on demand by supervisor.ts's dispatch background task (see dispatch.ts)
 * when it sees the hacking level change or a rooting pass finish, and once
 * at boot (see boot.ts) so a restart is never left without any weights at
 * all. Re-running it when nothing's actually changed is a cheap no-op —
 * that's the point of stamping the file with the hacking level it was
 * computed at.
 */
/**
 * Hack chance once prepped and rooted, at minimum security - what batches will
 * actually see. hackAnalyzeChance uses *current* security: right after an
 * install ecorp sits at 99, ~1% chance, so it ranked ~100x too low and
 * BN10 (hacking 6541) batched the-hub ($4.9B) instead. Needs Formulas.exe;
 * without it, the current chance.
 */
function chanceWhenPrepped(ns: NS, host: string): number {
  if (!ns.fileExists("Formulas.exe", "home")) return ns.hackAnalyzeChance(host);
  const server = ns.getServer(host);
  server.hackDifficulty = server.minDifficulty;
  // The game gives 0% without root; the scheduler only uses rooted
  // targets anyway, so score what the server is worth once rooted.
  server.hasAdminRights = true;
  return ns.formulas.hacking.hackChance(server, ns.getPlayer());
}


/**
 * Rough prep time: one weaken at current security (enough threads bring it
 * to min in one go), then PREP_ROUNDS_AT_MIN rounds at min security, which
 * are much faster. Formulas give the min-security weaken time; without
 * them, every round at the current time.
 */
function prepTimeEstimate(ns: NS, host: string): number {
  const now = ns.getWeakenTime(host);
  if (!ns.fileExists("Formulas.exe", "home")) return now * (1 + PREP_ROUNDS_AT_MIN);
  const server = ns.getServer(host);
  server.hackDifficulty = server.minDifficulty;
  return now + PREP_ROUNDS_AT_MIN * ns.formulas.hacking.weakenTime(server, ns.getPlayer());
}

/**
 * Ranks every hackable server (computeWeights) and writes the weights
 * file. network_daemon.ts calls this every tick, after rooting; this
 * script's main is for a one-off forced re-rank.
 */
export async function rankTargets(ns: NS, log: Logger): Promise<WeightedServer[]> {
  const config = loadConfig(ns);
  const hackingLevel = ns.getHackingLevel();
  // Every server on the network, scanned and checked live here. The
  // supervisor's list and its cached eligibility lagged (crawler pushes
  // time out; hacking level stale after an install): BN10 at hacking 6845
  // ranked nothing above the-hub, with ecorp/megacorp/blade missing.
  const level = ns.getHackingLevel();
  const eligible: server_metadata_pb.Metadata[] = [];
  for (const { host } of scanWithPaths(ns)) {
    // NPC servers only: getServerMaxMoney throws on Hacknet servers, and
    // home/purchased servers have no money to take.
    if (host === "home" || /^hacknet-(server|node)-/.test(host) || ns.getServer(host).purchasedByPlayer) continue;
    const maxMoney = ns.getServerMaxMoney(host);
    if (maxMoney > 0 && ns.getServerRequiredHackingLevel(host) <= level) {
      eligible.push({ hostname: host, maxMoney, minSecurityLevel: ns.getServerMinSecurityLevel(host) });
    }
  }
  const factors: NonNullable<WeightsFile["factors"]> = {};
  const weights = computeWeights(eligible, (host) => {
    const prepped =
      ns.getServerSecurityLevel(host) <= ns.getServerMinSecurityLevel(host) + 1 &&
      ns.getServerMoneyAvailable(host) >= ns.getServerMaxMoney(host) * 0.9;
    const chance = chanceWhenPrepped(ns, host);
    const discount = prepDiscount(prepped ? 0 : prepTimeEstimate(ns, host), PREP_HORIZON_MS);
    factors[host] = { maxMoney: ns.getServerMaxMoney(host), chance, discount };
    return chance * discount;
  });

  const file: WeightsFile = { hackingLevel, computedAt: Date.now(), weights, scorer: SCORER_VERSION, factors };
  ns.write(config.weightsPath, JSON.stringify(file, null, 2), "w");

  return weights;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "TargetSelector", LOG_LEVEL.INFO);
  const weights = await rankTargets(ns, log);
  await log.info(`[Weights] Recomputed for hacking level ${ns.getHackingLevel()}. Top target: ${weights[0]?.hostname ?? "none"}.`);
}
