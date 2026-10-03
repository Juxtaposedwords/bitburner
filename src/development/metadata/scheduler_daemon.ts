import { NS } from "@ns";
import { SCHEDULER_CONFIG_PATH } from "development/libraries/approach";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { applyDefined } from "development/libraries/merge";
import * as rpc from "development/libraries/rpc";
import { Codes } from "development/libraries/status";
import {
  allocateAcrossHosts,
  Allocation,
  computeBatchPlan,
  decidePrepAction,
  DEFAULT_MAX_HACK_FRACTION,
  HeldTarget,
  homeWorkerCapacity,
  homeWorkerRam,
  HostCapacity,
  nextHackFraction,
  prepThreadsNeeded,
  batchesPerTick,
  driftVerdict,
  SCHEDULER_TARGETS_PATH,
  SchedulerTargetsFile,
  TargetIncome,
  selectTargets,
} from "development/metadata/hwgw";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as scheduler_pb from "development/metadata/scheduler";
import * as server_metadata_pb from "development/metadata/server_metadata";
import { loadConfig as loadStockTargetConfig } from "development/metadata/stock_target_daemon";
import { loadConfig as loadTargetSelectorConfig, readWeightsFile } from "development/metadata/target_selector";

const HACK_WORKER = "development/metadata/hack_worker.js";
const GROW_WORKER = "development/metadata/grow_worker.js";
const WEAKEN_WORKER = "development/metadata/weaken_worker.js";

// Workers use home's RAM beyond a reserve for the daemons and tools
// (homeWorkerRam): config.homeReservedRamGb below
// config.homeFallbackHackingLevel, a larger one past it.
const HOME = "home";

/**
 * How often the background task below ticks. Deliberately not derived from
 * state.config.spacingMs — RpcServer.addBackgroundTask's interval is fixed
 * at registration time, so it can't track a value that's patchable at
 * runtime. spacingMs still fully controls the actual batch delay math
 * (computeBatchPlan); this only governs how often we check whether to fire
 * the next one.
 */
const BATCH_CHECK_INTERVAL_MS = 1000;

const DEFAULT_CONFIG: scheduler_pb.SchedulerConfig = {
  approach: scheduler_pb.Approach.HACK,
  // hackFraction below is only the starting point while this is on - see
  // adjustHackFraction.
  autoHackFraction: true,
  targetUtilization: 0.85,
  maxHackFraction: DEFAULT_MAX_HACK_FRACTION,
  // Raised from 0.02 now that the fleet has grown substantially since
  // that value was set (crawler/rooter keep finding more servers as
  // hacking level climbs) - bigger batches mean more threads, and
  // grow()/weaken() grant the exact same hacking exp per thread as
  // hack() (confirmed in Bitburner's own NetscriptFunctions.ts), so this
  // directly speeds up hacking level growth toward Daedalus's 2500
  // requirement without sacrificing money throughput. Still well under
  // the "textbook" 0.1 that needed over 1TB total RAM and skipped almost
  // every tick back when the fleet was smaller (see server_metadata.md);
  // watch scheduler_daemon.txt's fire rate and raise further if batches
  // are still landing reliably.
  hackFraction: 0.05,
  spacingMs: 200,
  homeFallbackHackingLevel: 50,
  homeReservedRamGb: 5,
};

/**
 * Persisted via loadJsonConfig, same as every other daemon's /etc/*.txt -
 * survives a restart (test_restart.js only wipes /var/log/ and
 * /var/supervisor/). This used to be in-memory only, so e.g. switching to
 * Approach.STOCK_TARGETING was silently undone by every restart. The file
 * is the source of truth: main() re-reads it every tick (so a hand-edit
 * takes effect within BATCH_CHECK_INTERVAL_MS, same as the other daemons),
 * and PatchSchedulerConfig writes the merged result back. `approach` is
 * stored as its numeric enum value (0 = HACK, 3 = STOCK_TARGETING) -
 * tools/set_scheduler_approach.js is the readable way to change it.
 */
// Shared with approach.ts, which lets other daemons read the approach from
// this file instead of over RPC.
export const CONFIG_PATH = SCHEDULER_CONFIG_PATH;

export function loadConfig(ns: NS): scheduler_pb.SchedulerConfig {
  return loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
}

export type SchedulerState = {
  config: scheduler_pb.SchedulerConfig;
};

export function createSchedulerState(config: Partial<scheduler_pb.SchedulerConfig> = {}): SchedulerState {
  return { config: { ...DEFAULT_CONFIG, ...config } };
}

/**
 * Builds the RPC handlers. Stays synchronous and RAM-only, same shape as
 * supervisor.ts's createHandlers/createPlayerHandlers - persistence is
 * injected via `onConfigChanged` rather than calling `ns` here, so the
 * handlers stay testable without a fake NS.
 */
export function createHandlers(
  state: SchedulerState,
  onConfigChanged: (config: scheduler_pb.SchedulerConfig) => void = () => {}
): scheduler_pb.SchedulerServiceHandlers {
  return {
    GetSchedulerConfig: (): scheduler_pb.GetSchedulerConfigResponse => ({ config: state.config }),

    PatchSchedulerConfig: (req: scheduler_pb.PatchSchedulerConfigRequest): scheduler_pb.PatchSchedulerConfigResponse => {
      if (req.config) {
        applyDefined(state.config, req.config);
        onConfigChanged(state.config);
      }
      return {};
    },
  };
}

/**
 * config.targetOverride wins when set (absolute, unconditional). Otherwise,
 * under Approach.STOCK_TARGETING, prefers the top pick from
 * stock_target_daemon.ts's own weights file - a stock-linked server we
 * currently hold long, ranked by position size (see that file's module
 * doc). If nothing qualifies there (no stock-linked long position exists
 * right now), falls through to the normal money/security ranking rather
 * than idling the whole scheduler over an empty portfolio - HACK always
 * uses that same normal ranking directly.
 */
export function resolveTarget(ns: NS, config: scheduler_pb.SchedulerConfig): string | undefined {
  return rankedTargets(ns, config)[0];
}

/**
 * Every usable target, best first: config.targetOverride alone if set;
 * else (STOCK_TARGETING) the stock-linked pick first, then
 * target_selector.ts's ranking - only servers actually rooted. The
 * supervisor's ROOTED status is computed from port openers owned, not from
 * a nuke having happened: right after a restart the top pick can be
 * unrooted, and every worker aimed at it crashes ("no root access").
 */
export function rankedTargets(ns: NS, config: scheduler_pb.SchedulerConfig): string[] {
  if (config.targetOverride) return [config.targetOverride];
  const out: string[] = [];
  if (config.approach === scheduler_pb.Approach.STOCK_TARGETING) {
    const stockTarget = readWeightsFile(ns, loadStockTargetConfig(ns).weightsPath)?.weights[0]?.hostname;
    if (stockTarget) out.push(stockTarget);
  }
  for (const w of readWeightsFile(ns, loadTargetSelectorConfig(ns).weightsPath)?.weights ?? []) {
    if (w.hostname && !out.includes(w.hostname)) out.push(w.hostname);
  }
  return out.filter((host) => ns.hasRootAccess(host));
}

// Minimum time on a target before a better-ranked one replaces it (selectTargets).
const TARGET_MIN_HOLD_MS = 20 * 60_000;
// Most targets batched at once; the best get RAM first (selectTargets), and
// a batch that doesn't fit stops the tick, so extra slots only use RAM the
// better targets left idle. Each target gets at most one batch a tick, so
// more targets is how a big fleet gets used: at 8, BN10 ran 15% of 177 TB.
const MAX_TARGETS = 24;


// --- Worker hosts: everywhere except `home` and Hacknet servers --------

/**
 * Every rooted server except `home` and Hacknet servers — the pool
 * hack/grow/weaken threads are allowed to run on. Hacknet servers are
 * excluded deliberately: ns.formulas.hacknetServers.hashGainRate takes
 * ramUsed as an input, so running HWGW scripts on one measurably reduces
 * its own hash output (see hacknet_decisions.ts) - they're reserved for
 * hash production, not general worker capacity. Queried fresh each call
 * rather than cached, since the pool only grows as rooter.ts roots more
 * servers (or the player buys some), and the RPC round trip is free (see
 * server_metadata.md's RAM notes) — there's no cost to asking supervisor
 * again.
 */
async function listWorkerHosts(ns: NS): Promise<string[]> {
  const res = await server_metadata_pb.NewSupervisorServiceClient(ns).ListServers({});
  if (res.status !== Codes.OK) return [];

  return (res.data?.servers ?? [])
    .filter(
      (server) =>
        server.rootStatus === server_metadata_pb.RootStatus.ROOTED &&
        server.hostname !== HOME &&
        server.kind !== server_metadata_pb.ServerKind.HACKNET
    )
    .map((server) => server.hostname as string)
    // Actually nuked, not just nukeable (see resolveTarget).
    .filter((host) => ns.hasRootAccess(host));
}

/** Copies the three worker scripts to `host` if they're not already there. `ns.exec` requires the script to already exist on the destination — it doesn't copy for you. */
function ensureWorkersDeployed(ns: NS, host: string): void {
  if (!ns.fileExists(HACK_WORKER, host)) {
    ns.scp([HACK_WORKER, GROW_WORKER, WEAKEN_WORKER], host, HOME);
  }
}

/** Live free RAM per host — a stale crawled snapshot isn't good enough here, since other things could be running on these hosts. */
function hostCapacities(ns: NS, hosts: string[]): HostCapacity[] {
  return hosts.map((host) => ({ host, freeRam: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }));
}

async function currentHackingLevel(ns: NS): Promise<number> {
  const res = await player_metadata_pb.NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort).GetPlayerMetadata({});
  return res.data?.player?.hackingLevel ?? 0;
}

/**
 * The worker-host pool for this tick: every rooted server except `home`,
 * plus home's RAM beyond its reserve (homeWorkerRam). Sorted
 * most-room-first for allocateAcrossHosts' greedy fill.
 */
/** homeWorkerRam's config-driven arguments: fallback level and reserved GB. */
function homeReserveArgs(config: scheduler_pb.SchedulerConfig): [number, number] {
  return [
    config.homeFallbackHackingLevel ?? DEFAULT_CONFIG.homeFallbackHackingLevel ?? 50,
    config.homeReservedRamGb ?? DEFAULT_CONFIG.homeReservedRamGb ?? 5,
  ];
}

async function getWorkerCapacities(ns: NS, config: scheduler_pb.SchedulerConfig): Promise<HostCapacity[]> {
  const capacities = hostCapacities(ns, await listWorkerHosts(ns));
  const level = await currentHackingLevel(ns);
  capacities.push({ host: HOME, freeRam: homeWorkerRam(ns.getServerMaxRam(HOME), ns.getServerUsedRam(HOME), level, ...homeReserveArgs(config)) });

  return capacities.filter((c) => c.freeRam > 0).sort((a, b) => b.freeRam - a.freeRam);
}

// --- hackFraction auto-scaling --------------------------------------------

/** Where the live, auto-scaled hackFraction is kept (config's value is only the start). */
export const SCHEDULER_STATE_PATH = "/var/scheduler_state.txt";
const MIN_ADJUST_INTERVAL_MS = 60_000;

type Tuning = { hackFraction: number; lastAdjustMs: number; noFitSinceAdjust: boolean };

function readTunedFraction(ns: NS): number | undefined {
  try {
    const value = (JSON.parse(ns.read(SCHEDULER_STATE_PATH) || "{}") as { hackFraction?: number }).hackFraction;
    return typeof value === "number" && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Once per interval - at least a minute, and at least one weaken time so the
 * last change has fully shown up in RAM use - moves hackFraction toward
 * config.targetUtilization of the worker hosts' RAM (nextHackFraction).
 */
async function adjustHackFraction(ns: NS, log: Logger, target: string, config: scheduler_pb.SchedulerConfig, tuning: Tuning): Promise<void> {
  const now = Date.now();
  if (now - tuning.lastAdjustMs < Math.max(MIN_ADJUST_INTERVAL_MS, ns.getWeakenTime(target))) return;

  const hosts = await listWorkerHosts(ns);
  // Home counts with its worker share: what workers may have there, and
  // what they use now (daemons excluded).
  const homeCapacity = homeWorkerCapacity(ns.getServerMaxRam(HOME), await currentHackingLevel(ns), ...homeReserveArgs(config));
  const homeWorkers = ns
    .ps(HOME)
    .filter((p) => [HACK_WORKER, GROW_WORKER, WEAKEN_WORKER].includes(p.filename.replace(/^\//, "")))
    .reduce((sum, p) => sum + ns.getScriptRam(p.filename) * p.threads, 0);
  const maxRam = hosts.reduce((sum, host) => sum + ns.getServerMaxRam(host), 0) + homeCapacity;
  const usedRam = hosts.reduce((sum, host) => sum + ns.getServerUsedRam(host), 0) + Math.min(homeWorkers, homeCapacity);
  const utilization = maxRam > 0 ? usedRam / maxRam : 1;
  const next = nextHackFraction(
    tuning.hackFraction,
    utilization,
    tuning.noFitSinceAdjust,
    config.targetUtilization ?? DEFAULT_CONFIG.targetUtilization ?? 0.85,
    config.maxHackFraction ?? DEFAULT_CONFIG.maxHackFraction ?? DEFAULT_MAX_HACK_FRACTION
  );
  if (next !== tuning.hackFraction) {
    await log.info(
      `[Scheduler] hackFraction ${tuning.hackFraction.toFixed(3)} -> ${next.toFixed(3)} ` +
        `(worker RAM ${(utilization * 100).toFixed(0)}% used${tuning.noFitSinceAdjust ? ", batches didn't fit" : ""}).`
    );
  }
  tuning.hackFraction = next;
  tuning.lastAdjustMs = now;
  tuning.noFitSinceAdjust = false;
  ns.write(SCHEDULER_STATE_PATH, JSON.stringify({ hackFraction: next, utilization, updatedAt: now }), "w");
}

// --- Prep and batch firing ----------------------------------------------

/**
 * One non-blocking prep step on `target`: weaken toward min security, or
 * grow toward max money, with only the threads that step needs
 * (prepThreadsNeeded), capped by free RAM across every worker host.
 * Returns how long until it lands (the target is skipped until then), 0
 * if it's already prepped. Prep used to block the whole scheduler until
 * done, which tied it to one target at a time.
 */
async function prepStep(ns: NS, log: Logger, target: string, config: scheduler_pb.SchedulerConfig): Promise<number> {
  const security = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const money = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const action = decidePrepAction(security, minSecurity, money, maxMoney);
  if (action === "done") return 0;

  const script = action === "weaken" ? WEAKEN_WORKER : GROW_WORKER;
  const scriptRam = ns.getScriptRam(script);
  // getScriptRam returns 0 for a file not synced yet - dividing by it would
  // ask ns.exec for Infinity threads. Wait for the sync instead.
  if (!(scriptRam > 0)) {
    await log.warn(`[Scheduler] ${script} not found on home (getScriptRam returned ${scriptRam}); waiting for it to sync.`);
    return BATCH_CHECK_INTERVAL_MS * 5;
  }
  const growMultiplier = maxMoney / Math.max(money, 1);
  let remaining = prepThreadsNeeded(
    action,
    security - minSecurity,
    ns.weakenAnalyze(1),
    action === "grow" ? ns.growthAnalyze(target, Math.max(1, growMultiplier)) : 0
  );

  let totalThreads = 0;
  for (const { host, freeRam } of await getWorkerCapacities(ns, config)) {
    if (remaining <= 0) break;
    const threads = Math.min(remaining, Math.floor(freeRam / scriptRam));
    if (threads <= 0) continue;
    ensureWorkersDeployed(ns, host);
    // stock: true always, harmless when target isn't stock-linked (see hack_worker.ts's doc).
    if (ns.exec(script, host, threads, target, 0, true) !== 0) {
      totalThreads += threads;
      remaining -= threads;
    }
  }
  if (totalThreads === 0) return BATCH_CHECK_INTERVAL_MS * 5;

  await log.info(
    `[Scheduler] Prep ${action} on ${target}: security=${security.toFixed(2)}/${minSecurity.toFixed(2)} money=$${money.toFixed(0)}/$${maxMoney.toFixed(0)} ` +
      `${totalThreads} thread(s)${remaining > 0 ? ` (${remaining} more needed - no room)` : ""}.`
  );
  return (action === "weaken" ? ns.getWeakenTime(target) : ns.getGrowTime(target)) + 200;
}

/**
 * Computes a fresh batch plan against `target`'s live state and, if the
 * pool of worker hosts (home beyond its reserve included) has room for all four actions
 * somewhere, fires it. Skips silently otherwise — the next tick naturally
 * retries, no pre-computed concurrent-batch depth needed. The four actions
 * don't need to land on the same host as each other, or as the target.
 */
async function fireBatchIfRoom(
  ns: NS,
  log: Logger,
  target: string,
  config: scheduler_pb.SchedulerConfig,
  offsetMs = 0
): Promise<"ok" | "fired" | "drifted" | "noFit"> {
  const hackFraction = config.hackFraction ?? DEFAULT_CONFIG.hackFraction ?? 0.1;
  const spacingMs = config.spacingMs ?? DEFAULT_CONFIG.spacingMs ?? 200;

  // Planned from per-thread figures, not live money: with several batches
  // in flight a target is usually mid-dip (a hack landed, its grow not yet),
  // and reading live money there flagged ~1 drift a second (BN10), each
  // idling a target for a full prep cycle.
  const perThread = ns.hackAnalyze(target);
  if (!(perThread > 0)) {
    await log.warn(`[Scheduler] ${target} not hackable right now (hackAnalyze returned ${perThread}); skipping.`);
    return "ok";
  }
  // One drift reading per tick (the first batch of the tick).
  if (offsetMs === 0) {
    const verdict = driftVerdict(
      driftStreak.get(target) ?? 0,
      ns.getServerSecurityLevel(target),
      ns.getServerMinSecurityLevel(target),
      ns.getServerMoneyAvailable(target),
      ns.getServerMaxMoney(target),
      DRIFT_STREAK_TICKS
    );
    driftStreak.set(target, verdict.streak);
    if (verdict.drifted) return "drifted";
  }

  const hackThreads = Math.max(1, Math.ceil(hackFraction / perThread));
  // What the hack really takes: at high hacking level one thread can take
  // more than hackFraction, and a grow sized for hackFraction then
  // under-refills - more drift.
  const takenFraction = Math.min(0.999, hackThreads * perThread);
  const growThreads = Math.ceil(ns.growthAnalyze(target, 1 / (1 - takenFraction)));

  const plan = computeBatchPlan(
    {
      hackThreads,
      // No `target` for either: with a host, the game caps the threads to
      // what reaching max money (grow) or taking all money (hack) needs. The
      // plan is made at max money, so growthAnalyzeSecurity(threads, target)
      // returned 0 - every batch fired with no second weaken (the "/W0" in
      // BN10's logs), security climbed, and the target drained.
      hackSecurityIncrease: ns.hackAnalyzeSecurity(hackThreads),
      growThreads,
      growSecurityIncrease: ns.growthAnalyzeSecurity(growThreads),
      weakenSecurityPerThread: ns.weakenAnalyze(1),
      hackTime: ns.getHackTime(target),
      growTime: ns.getGrowTime(target),
      weakenTime: ns.getWeakenTime(target),
    },
    spacingMs
  );

  const hackRam = ns.getScriptRam(HACK_WORKER);
  const growRam = ns.getScriptRam(GROW_WORKER);
  const weakenRam = ns.getScriptRam(WEAKEN_WORKER);
  // Same "0 means missing file" gap as prep() above - here it wouldn't
  // crash (ramPerThread=0 just makes allocateAcrossHosts treat every
  // host as having room, and ns.exec silently no-ops with pid 0 for a
  // missing script), but batches would silently never actually fire.
  if (!(hackRam > 0) || !(growRam > 0) || !(weakenRam > 0)) {
    await log.warn(
      `[Scheduler] One or more worker scripts missing on home (hackRam=${hackRam} growRam=${growRam} weakenRam=${weakenRam}); skipping tick.`
    );
    return "ok";
  }

  const capacities = await getWorkerCapacities(ns, config);
  const requests = [
    { threads: plan.hackThreads, ramPerThread: hackRam },
    { threads: plan.weaken1Threads, ramPerThread: weakenRam },
    { threads: plan.growThreads, ramPerThread: growRam },
    { threads: plan.weaken2Threads, ramPerThread: weakenRam },
  ];
  const placements = allocateAcrossHosts(capacities, requests);
  if (!placements) {
    const neededGb = requests.reduce((sum, r) => sum + r.threads * r.ramPerThread, 0);
    const availableGb = capacities.reduce((sum, c) => sum + c.freeRam, 0);
    await log.warn(
      `[Scheduler] Batch for ${target} (H${plan.hackThreads}/W${plan.weaken1Threads}/G${plan.growThreads}/W${plan.weaken2Threads}, ` +
        `needs ${neededGb.toFixed(2)} GB total) doesn't fit across ${capacities.length} worker host(s) ` +
        `(${availableGb.toFixed(2)} GB free total, see homeFallbackHackingLevel/homeReservedRamGb); skipping tick.`
    );
    return "noFit";
  }

  const [hack, weaken1, grow, weaken2] = placements;
  for (const host of new Set(placements.flat().map((a) => a.host))) ensureWorkersDeployed(ns, host);

  // A single action's threads may be spread across several hosts (see
  // allocateAcrossHosts) - fire one ns.exec per host it landed on, all with
  // the same additionalMsec so they still complete together. stock: true
  // always (see prep()'s identical comment above) - passed to the weaken
  // calls too for one uniform call shape, even though weaken_worker.ts
  // itself never reads it (weaken has no stock-market effect at all,
  // confirmed in Bitburner's own source).
  const fireOn = (script: string, group: Allocation[], delayMs: number): void => {
    for (const { host, threads } of group) {
      if (threads > 0) ns.exec(script, host, threads, target, delayMs, true);
    }
  };

  // offsetMs staggers several batches fired in one tick so each one's four
  // actions land in their own window (batchesPerTick).
  fireOn(HACK_WORKER, hack, plan.hackDelayMs + offsetMs);
  fireOn(WEAKEN_WORKER, weaken1, plan.weaken1DelayMs + offsetMs);
  fireOn(GROW_WORKER, grow, plan.growDelayMs + offsetMs);
  fireOn(WEAKEN_WORKER, weaken2, plan.weaken2DelayMs + offsetMs);

  const summarize = (group: Allocation[]): string => (group.length > 0 ? group.map((a) => `${a.threads}@${a.host}`).join("+") : "0");
  await log.debug(
    `[Scheduler] Fired batch on ${target}: H${summarize(hack)}/W${summarize(weaken1)}/G${summarize(grow)}/W${summarize(weaken2)}.`
  );
  return "fired";
}

const TARGETS_WRITE_INTERVAL_MS = 5000;
// Off readings in a row (one per tick) before a batching target counts as drifted (driftVerdict).
const DRIFT_STREAK_TICKS = 10;
// Per target: consecutive off readings (driftVerdict).
const driftStreak = new Map<string, number>();

/** Publishes each target's state and income (SCHEDULER_TARGETS_PATH), dropping fire times older than a minute. */
function writeTargetIncome(ns: NS, hosts: string[], prepped: Set<string>, firedAt: Map<string, number[]>, hackFraction: number, now: number): void {
  for (const [host, times] of firedAt) {
    const recent = times.filter((t) => now - t < 60_000);
    if (recent.length === 0 || !hosts.includes(host)) firedAt.delete(host);
    else firedAt.set(host, recent);
  }
  const targets: TargetIncome[] = hosts.map((host) => {
    const batchesPerMin = firedAt.get(host)?.length ?? 0;
    const chance = ns.hackAnalyzeChance(host);
    const takePerBatch = hackFraction * ns.getServerMaxMoney(host) * chance;
    return { host, state: prepped.has(host) ? "batching" : "prepping", batchesPerMin, takePerBatch, incomePerMin: batchesPerMin * takePerBatch, chance };
  });
  const file: SchedulerTargetsFile = { targets, writtenAt: now };
  ns.write(SCHEDULER_TARGETS_PATH, JSON.stringify(file), "w");
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so a long-running prep phase (which used to log nothing at all
  // per iteration) is visible tick-by-tick, same reasoning as hacknet_daemon.ts/
  // purchased_server_daemon.ts (see server_metadata.md).
  // INFO: per-batch lines are DEBUG and dropped (thousands a minute rotated
  // the log every 2 minutes); a summary is logged each minute instead.
  const log = createLogger(ns, "Scheduler", LOG_LEVEL.INFO);

  const state = createSchedulerState(loadConfig(ns));
  const handlers = createHandlers(state, (config) => ns.write(CONFIG_PATH, JSON.stringify(config, null, 2), "w"));

  const server = rpc.NewServer(ns, scheduler_pb.SchedulerServicePort);
  scheduler_pb.RegisterSchedulerService(server, handlers);

  // The targets being batched (selectTargets), and when each one's prep
  // step lands (prepStep) - skipped until then.
  let targets: HeldTarget[] = [];
  const busyUntil = new Map<string, number>();
  const prepped = new Set<string>();
  // Batch fire times per target over the last minute (writeTargetIncome).
  const firedAt = new Map<string, number[]>();
  let lastTargetsWrite = 0;
  let lastSummary = Date.now();
  let drifts = 0;
  // Auto-scaled hackFraction (adjustHackFraction), starting from the saved
  // value, else the config's.
  const tuning: Tuning = {
    hackFraction: readTunedFraction(ns) ?? state.config.hackFraction ?? DEFAULT_CONFIG.hackFraction ?? 0.05,
    lastAdjustMs: Date.now(),
    noFitSinceAdjust: false,
  };

  server.addBackgroundTask(async () => {
    // Re-read so hand-edits to /etc/scheduler.txt take effect without a
    // restart - PatchSchedulerConfig writes through to the same file, so
    // RPC patches survive this reload too.
    state.config = loadConfig(ns);

    // HACK, STOCK_TARGETING, GROW_STATS, AUGMENTS, GANG and FACTION_GRIND
    // all run the same HWGW batching; the approach only changes which
    // targets rank first (STOCK_TARGETING) or what the player and money do.
    const approach = state.config.approach;
    if (approach === scheduler_pb.Approach.CRIME) return;

    // Several targets at once (selectTargets), best first. Each tick the
    // best gets its prep step or batch first and lower ones use what's
    // left; a batch that doesn't fit means the fleet is full this tick.
    // One target at a time capped income at what one server can give:
    // BN10 ran 1% of 137 TB at hacking 6541.
    const now = Date.now();
    const ranked = rankedTargets(ns, state.config);
    const prepping = new Set(targets.map((t) => t.host).filter((host) => !prepped.has(host)));
    const next = selectTargets(targets, ranked, state.config.targetOverride ? 1 : MAX_TARGETS, now, TARGET_MIN_HOLD_MS, prepping);
    const names = next.map((t) => t.host).join(", ");
    if (names !== targets.map((t) => t.host).join(", ")) await log.info(`[Scheduler] Targets: ${names || "(none)"}.`);
    targets = next;
    for (const host of [...busyUntil.keys()]) if (!targets.some((t) => t.host === host)) busyUntil.delete(host);
    for (const host of [...prepped]) if (!targets.some((t) => t.host === host)) prepped.delete(host);
    if (targets.length === 0) {
      await log.warn("[Scheduler] No target available yet (waiting on target_selector.js); skipping tick.");
      return;
    }

    const auto = state.config.autoHackFraction ?? DEFAULT_CONFIG.autoHackFraction;
    const batchConfig = auto ? { ...state.config, hackFraction: tuning.hackFraction } : state.config;
    for (const { host } of targets) {
      if ((busyUntil.get(host) ?? 0) > now) continue;
      // Prep until first ready, then only after a batch reports drift -
      // mid-batch a target's money dips by design until its grow lands.
      if (!prepped.has(host)) {
        const prepMs = await prepStep(ns, log, host, state.config);
        if (prepMs > 0) {
          busyUntil.set(host, now + prepMs);
          continue;
        }
        prepped.add(host);
        await log.info(`[Scheduler] ${host} at min-security/max-money; starting batches.`);
      }
      // Several batches per target per tick, each offset by a full batch
      // window (4 x spacing) so they land in order. One per tick capped a
      // 2 PB fleet at 1% use (BN10: hacking fell to $39T/min).
      const spacing = batchConfig.spacingMs ?? DEFAULT_CONFIG.spacingMs ?? 200;
      const perTick = batchesPerTick(BATCH_CHECK_INTERVAL_MS, spacing);
      let result: "ok" | "fired" | "drifted" | "noFit" = "fired";
      for (let k = 0; k < perTick && result === "fired"; k++) {
        result = await fireBatchIfRoom(ns, log, host, batchConfig, k * 4 * spacing);
        if (result === "fired") firedAt.set(host, [...(firedAt.get(host) ?? []), now]);
      }
      if (result === "drifted") {
        prepped.delete(host);
        drifts++;
        await log.warn(`[Scheduler] ${host} drifted off min-security/max-money; re-prepping before more batches.`);
      }
      if (result === "noFit") {
        tuning.noFitSinceAdjust = true;
        break;
      }
    }
    if (auto) await adjustHackFraction(ns, log, targets[0].host, state.config, tuning);
    if (now - lastSummary >= 60_000) {
      const fired = [...firedAt.entries()].map(([host, times]) => ({ host, n: times.filter((t) => now - t < 60_000).length }));
      const total = fired.reduce((sum, f) => sum + f.n, 0);
      const top = fired.reduce((a, b) => (b.n > a.n ? b : a), { host: "none", n: 0 }).host;
      await log.info(`[Scheduler] Batch summary (60s): ${total} batches across ${targets.length} target(s), top ${top}; ${drifts} drift re-prep(s).`);
      lastSummary = now;
      drifts = 0;
    }
    if (now - lastTargetsWrite >= TARGETS_WRITE_INTERVAL_MS) {
      lastTargetsWrite = now;
      writeTargetIncome(ns, targets.map((t) => t.host), prepped, firedAt, batchConfig.hackFraction ?? DEFAULT_CONFIG.hackFraction ?? 0.1, now);
    }
    // CRIME: defined in the schema, not implemented yet (see scheduler.proto).
  }, BATCH_CHECK_INTERVAL_MS);

  await log.info(`[Scheduler] Serving SchedulerService on port ${scheduler_pb.SchedulerServicePort}...`);
  await server.Serve();
}
