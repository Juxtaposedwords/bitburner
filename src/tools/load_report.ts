import { NS } from "@ns";
import { scanWithPaths } from "hacking/network";

/**
 * What the game is busy with, for when it struggles to keep up:
 *
 *   run tools/load_report.js [--out /var/claude_out/load_report.txt]
 *
 * - Event-loop lag: how late 40 sleeps of 50 ms wake up. The game runs
 *   every script on one thread, so lag is the direct measure of it
 *   falling behind (a healthy game wakes within a few ms).
 * - Every running process across the network, grouped by script: count,
 *   threads, and how many started within the last 10 seconds (churn - each
 *   start and finish costs the game work).
 * - Each managed daemon's RAM and how long it has run.
 */
const LAG_SAMPLES = 40;
const SLEEP_MS = 50;
const CHURN_WINDOW_SEC = 10;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const lags: number[] = [];
  for (let i = 0; i < LAG_SAMPLES; i++) {
    const start = performance.now();
    await ns.asleep(SLEEP_MS);
    lags.push(performance.now() - start - SLEEP_MS);
  }
  lags.sort((a, b) => a - b);
  const pct = (q: number): number => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))];

  const scanStart = performance.now();
  const byScript = new Map<string, { processes: number; threads: number; young: number; hosts: Set<string> }>();
  let hosts = 0;
  for (const { host } of scanWithPaths(ns)) {
    hosts++;
    for (const p of ns.ps(host)) {
      const name = p.filename.replace(/^\//, "");
      const entry = byScript.get(name) ?? { processes: 0, threads: 0, young: 0, hosts: new Set<string>() };
      entry.processes++;
      entry.threads += p.threads;
      entry.hosts.add(host);
      const online = ns.getRunningScript(p.pid)?.onlineRunningTime ?? Infinity;
      if (online < CHURN_WINDOW_SEC) entry.young++;
      byScript.set(name, entry);
    }
  }
  const scanMs = performance.now() - scanStart;
  const total = [...byScript.values()].reduce((sum, e) => sum + e.processes, 0);
  const young = [...byScript.values()].reduce((sum, e) => sum + e.young, 0);

  const lines = [
    `event-loop lag over ${LAG_SAMPLES} x ${SLEEP_MS}ms sleeps: median ${pct(0.5).toFixed(0)}ms, p90 ${pct(0.9).toFixed(0)}ms, max ${lags[lags.length - 1].toFixed(0)}ms`,
    `${total} processes on ${hosts} hosts; ${young} started in the last ${CHURN_WINDOW_SEC}s (~${(young / CHURN_WINDOW_SEC).toFixed(0)}/s); counting them took ${scanMs.toFixed(0)}ms`,
    "by script (processes, threads, started <10s ago, hosts):",
    ...[...byScript.entries()]
      .sort((a, b) => b[1].processes - a[1].processes)
      .map(([name, e]) => `  ${String(e.processes).padStart(6)} ${String(e.threads).padStart(9)} ${String(e.young).padStart(6)} ${String(e.hosts.size).padStart(4)}  ${name}`),
  ];
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), lines.join("\n"), "w");
  else ns.tprint(lines.join("\n"));
}
