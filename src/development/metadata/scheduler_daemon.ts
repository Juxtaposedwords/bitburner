import { NS } from "@ns";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { applyDefined } from "development/libraries/merge";
import * as rpc from "development/libraries/rpc";
import { Codes } from "development/libraries/status";
import { allocateAcrossHosts, Allocation, computeBatchPlan, decidePrepAction, HostCapacity } from "development/metadata/hwgw";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as scheduler_pb from "development/metadata/scheduler";
import * as server_metadata_pb from "development/metadata/server_metadata";
import { loadConfig as loadTargetSelectorConfig, readWeightsFile } from "development/metadata/target_selector";

const HACK_WORKER = "development/metadata/hack_worker.js";
const GROW_WORKER = "development/metadata/grow_worker.js";
const WEAKEN_WORKER = "development/metadata/weaken_worker.js";

// Reserved for development by default — hack/grow/weaken threads only ever
// run here below config.homeFallbackHackingLevel, and even then never dip
// into the last config.homeReservedRamGb. See "Worker hosts" below.
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
  hackFraction: 0.1,
  spacingMs: 200,
  homeFallbackHackingLevel: 50,
  homeReservedRamGb: 5,
};

export type SchedulerState = {
  config: scheduler_pb.SchedulerConfig;
};

export function createSchedulerState(config: Partial<scheduler_pb.SchedulerConfig> = {}): SchedulerState {
  return { config: { ...DEFAULT_CONFIG, ...config } };
}

/**
 * Builds the RPC handlers. Stays synchronous and RAM-only, same shape as
 * supervisor.ts's createHandlers/createPlayerHandlers.
 */
export function createHandlers(state: SchedulerState): scheduler_pb.SchedulerServiceHandlers {
  return {
    GetSchedulerConfig: (): scheduler_pb.GetSchedulerConfigResponse => ({ config: state.config }),

    PatchSchedulerConfig: (req: scheduler_pb.PatchSchedulerConfigRequest): scheduler_pb.PatchSchedulerConfigResponse => {
      if (req.config) applyDefined(state.config, req.config);
      return {};
    },
  };
}

/** config.targetOverride wins when set; otherwise the current top pick from target_selector.ts's weights.txt. */
export function resolveTarget(ns: NS, config: scheduler_pb.SchedulerConfig): string | undefined {
  if (config.targetOverride) return config.targetOverride;

  const weightsFile = readWeightsFile(ns, loadTargetSelectorConfig(ns).weightsPath);
  return weightsFile?.weights[0]?.hostname;
}

// --- Worker hosts: everywhere except `home` ---------------------------

/**
 * Every rooted server except `home` — the pool hack/grow/weaken threads
 * are allowed to run on. Queried fresh each call rather than cached, since
 * the pool only grows as rooter.ts roots more servers (or the player buys
 * some), and the RPC round trip is free (see server_metadata.md's RAM
 * notes) — there's no cost to asking supervisor again.
 */
async function listWorkerHosts(ns: NS): Promise<string[]> {
  const res = await server_metadata_pb.NewSupervisorServiceClient(ns).ListServers({});
  if (res.status !== Codes.OK) return [];

  return (res.data?.servers ?? [])
    .filter((server) => server.rootStatus === server_metadata_pb.RootStatus.ROOTED && server.hostname !== HOME)
    .map((server) => server.hostname as string);
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
 * plus — below config.homeFallbackHackingLevel — home itself, with
 * config.homeReservedRamGb held back so development always has headroom.
 * Early on, home may be the only significant RAM source before enough is
 * rooted/purchased elsewhere; past that hacking level, home reverts to
 * fully reserved, same as it stays for every other purpose in this
 * codebase. Sorted most-room-first for allocateAcrossHosts' greedy fill.
 */
async function getWorkerCapacities(ns: NS, config: scheduler_pb.SchedulerConfig): Promise<HostCapacity[]> {
  const capacities = hostCapacities(ns, await listWorkerHosts(ns));

  const fallbackLevel = config.homeFallbackHackingLevel ?? DEFAULT_CONFIG.homeFallbackHackingLevel ?? 50;
  if ((await currentHackingLevel(ns)) < fallbackLevel) {
    const reserved = config.homeReservedRamGb ?? DEFAULT_CONFIG.homeReservedRamGb ?? 5;
    capacities.push({ host: HOME, freeRam: ns.getServerMaxRam(HOME) - ns.getServerUsedRam(HOME) - reserved });
  }

  return capacities.filter((c) => c.freeRam > 0).sort((a, b) => b.freeRam - a.freeRam);
}

// --- Prep and batch firing ----------------------------------------------

/**
 * Weakens/grows `target` until it sits at min-security/max-money — batch
 * math is only valid from that baseline. Uses whichever worker host
 * currently has the most free RAM; unlike a batch's four coordinated
 * actions, prep doesn't need an exact thread count to make progress, just
 * however many threads fit (fewer just means it takes longer).
 */
async function prep(ns: NS, log: Logger, target: string, config: scheduler_pb.SchedulerConfig): Promise<void> {
  while (true) {
    const security = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    const action = decidePrepAction(security, minSecurity, money, maxMoney);
    if (action === "done") {
      await log.info(`[Scheduler] ${target} at min-security/max-money; starting batches.`);
      return;
    }

    const capacities = await getWorkerCapacities(ns, config);
    if (capacities.length === 0) {
      await log.warn("[Scheduler] No worker hosts with free RAM yet; waiting.");
      await ns.asleep(BATCH_CHECK_INTERVAL_MS);
      continue;
    }

    const best = capacities[0];
    const script = action === "weaken" ? WEAKEN_WORKER : GROW_WORKER;
    ensureWorkersDeployed(ns, best.host);

    const threads = Math.max(1, Math.floor(best.freeRam / ns.getScriptRam(script)));
    ns.exec(script, best.host, threads, target, 0);

    const waitMs = (action === "weaken" ? ns.getWeakenTime(target) : ns.getGrowTime(target)) + 200;
    await ns.asleep(waitMs);
  }
}

/**
 * Computes a fresh batch plan against `target`'s live state and, if the
 * pool of worker hosts (never `home`) has room for all four actions
 * somewhere, fires it. Skips silently otherwise — the next tick naturally
 * retries, no pre-computed concurrent-batch depth needed. The four actions
 * don't need to land on the same host as each other, or as the target.
 */
async function fireBatchIfRoom(ns: NS, log: Logger, target: string, config: scheduler_pb.SchedulerConfig): Promise<void> {
  const hackFraction = config.hackFraction ?? DEFAULT_CONFIG.hackFraction ?? 0.1;
  const spacingMs = config.spacingMs ?? DEFAULT_CONFIG.spacingMs ?? 200;

  const maxMoney = ns.getServerMaxMoney(target);
  const hackThreadsRaw = ns.hackAnalyzeThreads(target, maxMoney * hackFraction);
  // -1 means unhackable right now (e.g. money below the requested amount,
  // hacking level too low) - not an error, just not batchable this tick.
  if (hackThreadsRaw <= 0) {
    await log.warn(`[Scheduler] ${target} not hackable for hackFraction ${hackFraction} right now (hackAnalyzeThreads returned ${hackThreadsRaw}); skipping tick.`);
    return;
  }

  const hackThreads = Math.ceil(hackThreadsRaw);
  const growThreads = Math.ceil(ns.growthAnalyze(target, 1 / (1 - hackFraction)));

  const plan = computeBatchPlan(
    {
      hackThreads,
      hackSecurityIncrease: ns.hackAnalyzeSecurity(hackThreads, target),
      growThreads,
      growSecurityIncrease: ns.growthAnalyzeSecurity(growThreads, target),
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
    return;
  }

  const [hack, weaken1, grow, weaken2] = placements;
  for (const host of new Set(placements.flat().map((a) => a.host))) ensureWorkersDeployed(ns, host);

  // A single action's threads may be spread across several hosts (see
  // allocateAcrossHosts) - fire one ns.exec per host it landed on, all with
  // the same additionalMsec so they still complete together.
  const fireOn = (script: string, group: Allocation[], delayMs: number): void => {
    for (const { host, threads } of group) {
      if (threads > 0) ns.exec(script, host, threads, target, delayMs);
    }
  };

  fireOn(HACK_WORKER, hack, plan.hackDelayMs);
  fireOn(WEAKEN_WORKER, weaken1, plan.weaken1DelayMs);
  fireOn(GROW_WORKER, grow, plan.growDelayMs);
  fireOn(WEAKEN_WORKER, weaken2, plan.weaken2DelayMs);

  const summarize = (group: Allocation[]): string => (group.length > 0 ? group.map((a) => `${a.threads}@${a.host}`).join("+") : "0");
  await log.info(
    `[Scheduler] Fired batch on ${target}: H${summarize(hack)}/W${summarize(weaken1)}/G${summarize(grow)}/W${summarize(weaken2)}.`
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Scheduler", LOG_LEVEL.INFO);

  const state = createSchedulerState();
  const handlers = createHandlers(state);

  const server = rpc.NewServer(ns, scheduler_pb.SchedulerServicePort);
  scheduler_pb.RegisterSchedulerService(server, handlers);

  let currentTarget: string | undefined;

  server.addBackgroundTask(async () => {
    const target = resolveTarget(ns, state.config);
    if (!target) {
      await log.warn("[Scheduler] No target available yet (waiting on target_selector.js); skipping tick.");
      return;
    }

    if (target !== currentTarget) {
      await log.info(`[Scheduler] Retargeting ${currentTarget ?? "(none)"} -> ${target}.`);
      currentTarget = target;
      await prep(ns, log, target, state.config);
    }

    if (state.config.approach === scheduler_pb.Approach.HACK) {
      await fireBatchIfRoom(ns, log, target, state.config);
    }
    // GROW_STATS/CRIME: defined in the schema, not implemented yet (see scheduler.proto).
  }, BATCH_CHECK_INTERVAL_MS);

  await log.info(`[Scheduler] Serving SchedulerService on port ${scheduler_pb.SchedulerServicePort}...`);
  await server.Serve();
}
