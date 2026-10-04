/**
 * Numbers a single batch needs, already computed live against the target
 * (hackAnalyzeThreads/hackAnalyzeSecurity/growthAnalyze/growthAnalyzeSecurity/
 * weakenAnalyze/get{Hack,Grow,Weaken}Time) — this module never calls `ns`
 * itself, since those functions need live game state that can't be
 * reproduced as pure math.
 */
export type BatchInputs = {
  hackThreads: number;
  hackSecurityIncrease: number;
  growThreads: number;
  growSecurityIncrease: number;
  weakenSecurityPerThread: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
};

export type BatchPlan = {
  hackThreads: number;
  weaken1Threads: number;
  growThreads: number;
  weaken2Threads: number;
  hackDelayMs: number;
  weaken1DelayMs: number;
  growDelayMs: number;
  weaken2DelayMs: number;
  /** How long from launch until the last action (weaken2) completes. */
  totalDurationMs: number;
};

/**
 * Thread counts (rounded up — fractional threads aren't launchable) plus
 * per-action `additionalMsec` delays so all four actions, launched
 * simultaneously, *complete* in order hack -> weaken1 -> grow -> weaken2,
 * each `spacingMs` apart.
 *
 * Anchored on weaken1DelayMs = 0: weaken has the longest natural duration
 * of the four (weakenTime = 4x hackTime, growTime = 3.2x hackTime), so it's
 * the only anchor point that keeps every other delay non-negative — hack
 * and grow both need to be *held back* to finish after something that
 * takes longer than them but started at the same instant; weaken2 only
 * needs to finish 2*spacingMs after weaken1, which the same base duration
 * accomplishes with a small positive delay.
 *
 * Except when actions are very fast: hackDelay = weakenTime - spacingMs -
 * hackTime = 3*hackTime - spacingMs goes negative once hackTime drops below
 * spacingMs / 3 (~67ms at 200ms spacing) - reachable at high hacking level
 * against easy targets - and ns.hack rejects a negative additionalMsec
 * ("additionalMsec must be non-negative"). So every delay is shifted later
 * by the same amount until none is negative: completion order and spacing
 * are unchanged, the whole batch just starts a little later.
 */
export function computeBatchPlan(inputs: BatchInputs, spacingMs: number): BatchPlan {
  const raw = {
    hack: inputs.weakenTime - spacingMs - inputs.hackTime,
    weaken1: 0,
    grow: inputs.weakenTime + spacingMs - inputs.growTime,
    weaken2: 2 * spacingMs,
  };
  const shift = Math.max(0, -Math.min(raw.hack, raw.weaken1, raw.grow, raw.weaken2));
  return {
    hackThreads: Math.ceil(inputs.hackThreads),
    weaken1Threads: Math.ceil(inputs.hackSecurityIncrease / inputs.weakenSecurityPerThread),
    growThreads: Math.ceil(inputs.growThreads),
    weaken2Threads: Math.ceil(inputs.growSecurityIncrease / inputs.weakenSecurityPerThread),
    hackDelayMs: raw.hack + shift,
    weaken1DelayMs: raw.weaken1 + shift,
    growDelayMs: raw.grow + shift,
    weaken2DelayMs: raw.weaken2 + shift,
    totalDurationMs: inputs.weakenTime + 2 * spacingMs + shift,
  };
}

export type PrepAction = "weaken" | "grow" | "done";

/**
 * Batch math is only valid when a target starts at min-security/max-money
 * (see hwgw.ts's header and server_metadata.md) — this is the decision
 * scheduler.ts's prep phase makes each iteration to get there, before the
 * batch loop starts. Thresholds default to a small tolerance rather than
 * exact equality, since weaken/grow overshoot slightly by nature.
 */
export function decidePrepAction(
  security: number,
  minSecurity: number,
  money: number,
  maxMoney: number,
  securityThreshold = 0.01,
  moneyThreshold = 0.01
): PrepAction {
  if (security > minSecurity + securityThreshold) return "weaken";
  if (money < maxMoney * (1 - moneyThreshold)) return "grow";
  return "done";
}

export type HostCapacity = { host: string; freeRam: number };
export type ThreadRequest = { threads: number; ramPerThread: number };
export type Allocation = { host: string; threads: number };

/**
 * Round-robin fill of a batch's four actions across whatever rooted worker
 * hosts have room. Each request's threads can be *split* across multiple
 * hosts — a single action's thread count routinely exceeds what any one
 * host can hold on its own (e.g. hundreds of hack threads against a juicy
 * target). One thread is handed to each host-with-room per pass, cycling
 * through the candidate list repeatedly, rather than draining the biggest
 * host first — a workload big enough to need every host (the common case
 * for real batches, hundreds of threads against a handful of hosts) ends
 * up spread across the whole fleet instead of concentrated on the fewest/
 * biggest hosts, which otherwise left most of the fleet idle even when it
 * had room to help. A host that runs out of capacity mid-way is simply
 * skipped in later passes while the rest keep cycling. (This spreads a
 * *given* thread count across as many hosts as it actually needs — it
 * doesn't manufacture extra threads to keep every host busy regardless of
 * batch size; that's a separate, unrelated lever.)
 *
 * Returns undefined if *any* request's full thread count can't be placed
 * even after exhausting every host's capacity across every pass — callers
 * should treat that as "abort the whole batch, retry next tick" rather than
 * firing a partial one (a batch's timing math assumes all four actions run
 * at their full thread count).
 */
export function allocateAcrossHosts(candidates: HostCapacity[], requests: ThreadRequest[]): Allocation[][] | undefined {
  const remaining = candidates.map((c) => ({ ...c }));
  const result: Allocation[][] = [];

  for (const { threads, ramPerThread } of requests) {
    let threadsLeft = threads;
    const placedByHost = new Map<string, number>();

    while (threadsLeft > 0) {
      let placedThisPass = false;
      for (const host of remaining) {
        if (threadsLeft <= 0) break;
        if (host.freeRam < ramPerThread) continue;

        host.freeRam -= ramPerThread;
        placedByHost.set(host.host, (placedByHost.get(host.host) ?? 0) + 1);
        threadsLeft--;
        placedThisPass = true;
      }
      if (!placedThisPass) break;
    }

    if (threadsLeft > 0) return undefined;
    result.push([...placedByHost.entries()].map(([host, threadCount]) => ({ host, threads: threadCount })));
  }

  return result;
}

export const MIN_HACK_FRACTION = 0.01;
// Above this grow threads explode (regrowing from almost nothing) - cap it.
export const DEFAULT_MAX_HACK_FRACTION = 0.9;
const RAISE_FACTOR = 1.25;
const LOWER_FACTOR = 0.85;
// Treat the fleet as full above this even if batches still fit.
const FULL_UTILIZATION = 0.95;

/**
 * The next hackFraction for the scheduler's auto-scaling (called once per
 * adjustment interval, at least a weaken time apart so a change has shown
 * up in RAM use before the next one): lower it by 15% when batches stopped
 * fitting or worker RAM use is above 95%; raise it by 25% while use is
 * below `targetUtilization`; otherwise keep it. Bounded to
 * [MIN_HACK_FRACTION, maxFraction]. Bigger batches steal more per batch
 * and use proportionally more RAM - BN10's fixed 5% left half the fleet
 * idle and earned ~6x less than 25% on the same target.
 */
export function nextHackFraction(
  current: number,
  utilization: number,
  batchesDidntFit: boolean,
  targetUtilization: number,
  maxFraction = DEFAULT_MAX_HACK_FRACTION
): number {
  const clamp = (f: number): number => Math.min(maxFraction, Math.max(MIN_HACK_FRACTION, f));
  if (batchesDidntFit || utilization > FULL_UTILIZATION) return clamp(current * LOWER_FACTOR);
  if (utilization < targetUtilization) return clamp(current * RAISE_FACTOR);
  return clamp(current);
}

/**
 * Home RAM the scheduler may fill with workers. Below `fallbackLevel`
 * (a fresh BitNode, home the only real RAM) everything but `reservedGb`.
 * Past it, everything but a reserve for the daemons and tools: the larger
 * of `reservedGb`, `reserveFraction` of home, and `minReserveGb` - so a
 * small home stays untouched, and a big one works. Home RAM survives
 * installs while purchased servers don't: BN10's second run had ~16 TB of
 * home idle after an install while prep crawled on 56 threads elsewhere,
 * because home was only ever used below hacking level 50.
 */
export function homeWorkerRam(
  maxRam: number,
  usedRam: number,
  hackingLevel: number,
  fallbackLevel: number,
  reservedGb: number,
  reserveFraction = 0.1,
  minReserveGb = 64
): number {
  const reserve = hackingLevel < fallbackLevel ? reservedGb : Math.max(reservedGb, maxRam * reserveFraction, minReserveGb);
  return Math.max(0, maxRam - usedRam - reserve);
}

/** The most home RAM workers can ever have (homeWorkerRam with nothing running) - for utilization. */
export function homeWorkerCapacity(maxRam: number, hackingLevel: number, fallbackLevel: number, reservedGb: number, reserveFraction = 0.1, minReserveGb = 64): number {
  return homeWorkerRam(maxRam, 0, hackingLevel, fallbackLevel, reservedGb, reserveFraction, minReserveGb);
}

export type HeldTarget = { host: string; since: number };

/**
 * The targets to batch this tick, best first: up to `k` from `ranked`
 * (rooted, best first). A current target stays while it's still in
 * `ranked` and either within the top `k`, or still being prepped
 * (`prepping`) and held for less than `minHoldMs` - a re-rank doesn't throw
 * away a prep in progress, but a prepped small target gives its slot to a
 * better one at once (the hold once kept 7 small targets while ecorp
 * waited). Free slots fill from the top of `ranked`.
 */
export function selectTargets(
  current: HeldTarget[],
  ranked: string[],
  k: number,
  now: number,
  minHoldMs: number,
  prepping: Set<string> = new Set()
): HeldTarget[] {
  const top = ranked.slice(0, k);
  const kept = current.filter(
    (t) => ranked.includes(t.host) && (top.includes(t.host) || (prepping.has(t.host) && now - t.since < minHoldMs))
  );
  const out = [...kept];
  for (const host of ranked) {
    if (out.length >= k) break;
    if (!out.some((t) => t.host === host)) out.push({ host, since: now });
  }
  return out.slice(0, Math.max(k, kept.length)).sort((a, b) => ranked.indexOf(a.host) - ranked.indexOf(b.host));
}

/**
 * Threads one prep step needs: weaken down to min security, or grow to max
 * money (the next step weakens what the grow added). Capped by the caller
 * to free RAM; sized so one target's prep doesn't take the whole fleet
 * from the others.
 */
export function prepThreadsNeeded(action: "weaken" | "grow", securityGap: number, weakenPerThread: number, growThreads: number): number {
  if (action === "weaken") return weakenPerThread > 0 ? Math.max(1, Math.ceil(securityGap / weakenPerThread)) : 1;
  return Math.max(1, Math.ceil(growThreads));
}

/**
 * Batches one target can take per scheduler tick: as many 4-action windows
 * (4 x spacingMs each) as fit in the tick, at least 1.
 */
export function batchesPerTick(tickMs: number, spacingMs: number): number {
  if (!(spacingMs > 0)) return 1;
  return Math.max(1, Math.floor(tickMs / (4 * spacingMs)));
}

/**
 * Per-target state the scheduler publishes (SCHEDULER_TARGETS_PATH): what
 * each target earns now - batches in the last minute x the planned take
 * per batch (hackFraction x maxMoney x hack chance). hacknet_daemon.ts
 * spends hashes on the top earner; tools/status.js shows the shares.
 */
export const SCHEDULER_TARGETS_PATH = "/var/scheduler_targets.txt";
export type TargetIncome = { host: string; state: "prepping" | "batching"; batchesPerMin: number; takePerBatch: number; incomePerMin: number; chance: number };
export type SchedulerTargetsFile = {
  targets: TargetIncome[];
  // Drift re-preps in the last minute (driftVerdict) - a high count means batches land out of order.
  driftsLastMin?: number;
  writtenAt: number;
};

/** The batching target earning the most, or undefined. */
export function topEarner(targets: TargetIncome[]): TargetIncome | undefined {
  const batching = targets.filter((t) => t.state === "batching" && t.incomePerMin > 0);
  return batching.length === 0 ? undefined : batching.reduce((a, b) => (b.incomePerMin > a.incomePerMin ? b : a));
}

/**
 * Whether a batching target has really drifted (needs a prep), from one
 * reading per tick. Mid-batch a target is often off - a hack landed, its
 * grow not yet - for a fraction of a second, so an off reading alone only
 * adds to a streak; `streakTicks` off readings in a row (a dip doesn't last
 * that long) mean it's drained. Security far above min (more than in-flight
 * batches add) means drift at once.
 */
export function driftVerdict(
  streak: number,
  security: number,
  minSecurity: number,
  money: number,
  maxMoney: number,
  streakTicks: number
): { drifted: boolean; streak: number } {
  if (security > minSecurity + Math.max(1, 0.05 * minSecurity)) return { drifted: true, streak: 0 };
  if (decidePrepAction(security, minSecurity, money, maxMoney) === "done") return { drifted: false, streak: 0 };
  const next = streak + 1;
  return next >= streakTicks ? { drifted: true, streak: 0 } : { drifted: false, streak: next };
}
