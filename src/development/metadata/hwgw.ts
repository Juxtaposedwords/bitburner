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
 */
export function computeBatchPlan(inputs: BatchInputs, spacingMs: number): BatchPlan {
  return {
    hackThreads: Math.ceil(inputs.hackThreads),
    weaken1Threads: Math.ceil(inputs.hackSecurityIncrease / inputs.weakenSecurityPerThread),
    growThreads: Math.ceil(inputs.growThreads),
    weaken2Threads: Math.ceil(inputs.growSecurityIncrease / inputs.weakenSecurityPerThread),
    hackDelayMs: inputs.weakenTime - spacingMs - inputs.hackTime,
    weaken1DelayMs: 0,
    growDelayMs: inputs.weakenTime + spacingMs - inputs.growTime,
    weaken2DelayMs: 2 * spacingMs,
    totalDurationMs: inputs.weakenTime + 2 * spacingMs,
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
 * Greedy fill of a batch's four actions across whatever rooted worker hosts
 * have room. Each request's threads can be *split* across multiple hosts —
 * a single action's thread count routinely exceeds what any one host can
 * hold on its own (e.g. hundreds of hack threads against a juicy target),
 * even when the pool's combined free RAM easily covers it. Requiring one
 * host per request (the original design) would reject batches like that
 * outright, leaving most of the fleet's RAM unusable. Hosts are drained in
 * the order given (callers sort most-room-first) and a running reservation
 * is tracked per host so later requests see the room already claimed by
 * earlier ones.
 *
 * Returns undefined if *any* request's full thread count can't be placed
 * even after spreading across every host — callers should treat that as
 * "abort the whole batch, retry next tick" rather than firing a partial one
 * (a batch's timing math assumes all four actions run at their full thread
 * count).
 */
export function allocateAcrossHosts(candidates: HostCapacity[], requests: ThreadRequest[]): Allocation[][] | undefined {
  const remaining = candidates.map((c) => ({ ...c }));
  const result: Allocation[][] = [];

  for (const { threads, ramPerThread } of requests) {
    let threadsLeft = threads;
    const placements: Allocation[] = [];

    for (const host of remaining) {
      if (threadsLeft <= 0) break;
      const capacity = Math.floor(host.freeRam / ramPerThread);
      if (capacity <= 0) continue;

      const take = Math.min(capacity, threadsLeft);
      host.freeRam -= take * ramPerThread;
      placements.push({ host: host.host, threads: take });
      threadsLeft -= take;
    }

    if (threadsLeft > 0) return undefined;
    result.push(placements);
  }

  return result;
}
