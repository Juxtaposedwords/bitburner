/**
 * Pure sizing/placement for share_daemon.ts - no `ns` dependency.
 *
 * ns.share() raises the reputation gain of all faction work while it runs,
 * by 1 + ln(threads) / 25 (Bitburner's NetworkShare/Share.ts): 100 threads
 * gives +18%, 1,000 gives +28%, 10,000 only +37%. Every 10x more RAM adds
 * ~9%. The RAM comes out of HWGW batches, so how much to give depends on
 * what batches are worth in the current BitNode - in BN9 (HackExpGain 0.05,
 * ScriptHackMoney 0.1, ServerMaxMoney 0.01) almost nothing, which is why
 * share_daemon.ts defaults to half the fleet.
 */

/** Share threads to keep running: `fraction` of the fleet's total RAM, in whole threads. */
export function shareThreadTarget(totalFleetRam: number, fraction: number, ramPerThread: number): number {
  if (ramPerThread <= 0 || fraction <= 0) return 0;
  return Math.floor((totalFleetRam * Math.min(1, fraction)) / ramPerThread);
}

/** Predicted rep-gain multiplier for `threads` share threads (ignoring core and intelligence bonuses). */
export function shareBonus(threads: number): number {
  return threads <= 0 ? 1 : 1 + Math.log(threads) / 25;
}

/**
 * Places up to `threads` share threads onto hosts with free RAM, biggest
 * free RAM first, as many per host as fit. Unlike an HWGW batch (which is
 * all-or-nothing - see hwgw.ts's allocateAcrossHosts), a partial placement
 * is still useful here, so this never fails - it places what fits and the
 * next pass tops up the rest.
 */
export function planShareLaunches(
  capacities: { host: string; freeRam: number }[],
  threads: number,
  ramPerThread: number
): { host: string; threads: number }[] {
  if (threads <= 0 || ramPerThread <= 0) return [];
  const launches: { host: string; threads: number }[] = [];
  let remaining = threads;
  for (const { host, freeRam } of [...capacities].sort((a, b) => b.freeRam - a.freeRam)) {
    if (remaining <= 0) break;
    const fit = Math.min(remaining, Math.floor(freeRam / ramPerThread));
    if (fit <= 0) continue;
    launches.push({ host, threads: fit });
    remaining -= fit;
  }
  return launches;
}

/**
 * Which running share processes to kill to get down to `target` threads
 * (after lowering the fraction, or disabling). Kills the smallest processes
 * first, so the fewest RAM-hungry big ones get churned; a process that would
 * overshoot below target is still killed - share threads can't be resized
 * in place, and the next pass tops back up.
 */
export function planShareKills(running: { pid: number; threads: number }[], target: number): number[] {
  let total = running.reduce((sum, p) => sum + p.threads, 0);
  const kills: number[] = [];
  for (const p of [...running].sort((a, b) => a.threads - b.threads)) {
    if (total <= target) break;
    kills.push(p.pid);
    total -= p.threads;
  }
  return kills;
}
