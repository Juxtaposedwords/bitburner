import { NS } from "@ns";
import { readApproach } from "development/libraries/approach";
import { readBitNodeInfo } from "development/libraries/bitnode_info";
import { readInstallPending } from "development/libraries/install_handshake";
import { readSavings } from "development/libraries/savings";
import { parseWindow, readSeries, windowPoints } from "development/libraries/timeseries";
import { FACTION_REPS_PATH, FactionRepsFile } from "development/metadata/faction_decisions";
import { GANG_STATUS_PATH, GangStatusFile } from "development/metadata/gang_decisions";
import { Approach } from "development/metadata/scheduler";
import { SLEEVES_PATH, sleevesAvailable, SleevesFile } from "development/metadata/sleeve_decisions";
import { checkStatus, Finding, formatMoney, StatusSnapshot, summarizeScheduler } from "tools/status_checks";

/**
 * One-screen health check of the whole system:
 *
 *   run tools/status.js [--window 10m]
 *
 * Problems first (status_checks.ts - each one a stall that once went
 * unnoticed for hours), then a summary of mode, money, work, gang, sleeves
 * and installs. Reads only what the daemons already publish - status files,
 * monitoring series, the scheduler's log - plus home's process list, so it
 * costs almost no RAM and can't disturb anything.
 */

const DEFAULT_WINDOW_SEC = 10 * 60;
// Longer window the recent hacking rate is compared against.
const BASELINE_WINDOW_SEC = 3 * 3600;
const SCHEDULER_LOG = "/var/log/home/scheduler_daemon.txt";
const SCHEDULER_LOG_LINES = 30;

type Expected = { script: string; core: boolean; when?: boolean };

function readJson<T>(ns: NS, path: string): T | undefined {
  const raw = ns.read(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Per-minute change of a monitoring series over the window: positive for
 * rising values; `falling` flips it for karma, which only goes down.
 */
function ratePerMin(ns: NS, id: string, windowSec: number, falling = false): number | undefined {
  const series = readSeries(ns, id);
  if (!series) return undefined;
  const points = windowPoints(series, Math.floor(Date.now() / 1000), windowSec).filter((p): p is { t: number; v: number } => p.v !== null);
  if (points.length < 2) return undefined;
  const first = points[0];
  const last = points[points.length - 1];
  const delta = falling ? first.v - last.v : last.v - first.v;
  return delta / ((last.t - first.t) / 60);
}

function money(n: number | undefined): string {
  return n === undefined ? "n/a" : formatMoney(n);
}

const WORKERS = [
  "development/metadata/hack_worker.js",
  "development/metadata/grow_worker.js",
  "development/metadata/weaken_worker.js",
  "development/metadata/share_worker.js",
  "bootstrap_worker.js",
];

function allServers(ns: NS): string[] {
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

/**
 * RAM across rooted servers, and processes/threads per worker script - how
 * busy the fleet is, and how many separate processes the batches make.
 */
function fleetLines(ns: NS): string[] {
  let maxRam = 0;
  let usedRam = 0;
  const procs = new Map<string, { processes: number; threads: number; hosts: Set<string> }>();
  for (const host of allServers(ns)) {
    if (!ns.hasRootAccess(host)) continue;
    maxRam += ns.getServerMaxRam(host);
    usedRam += ns.getServerUsedRam(host);
    for (const p of ns.ps(host)) {
      const file = p.filename.replace(/^\//, "");
      if (!WORKERS.includes(file)) continue;
      const entry = procs.get(file) ?? { processes: 0, threads: 0, hosts: new Set<string>() };
      entry.processes++;
      entry.threads += p.threads;
      entry.hosts.add(host);
      procs.set(file, entry);
    }
  }
  const lines = [`fleet RAM: ${(usedRam / 1024).toFixed(1)} of ${(maxRam / 1024).toFixed(1)} TB used (${maxRam > 0 ? ((usedRam / maxRam) * 100).toFixed(0) : 0}%)`];
  for (const [file, e] of procs) {
    lines.push(`  ${file.split("/").pop()?.padEnd(20)} ${String(e.processes).padStart(6)} processes  ${String(e.threads).padStart(8)} threads  on ${e.hosts.size} host(s)`);
  }
  if (procs.size === 0) lines.push("  no worker processes running");
  return lines;
}

export async function main(ns: NS): Promise<void> {
  const args = ns.args.map(String);
  const windowIdx = args.indexOf("--window");
  const windowSec = (windowIdx >= 0 ? parseWindow(args[windowIdx + 1] ?? "") : undefined) ?? DEFAULT_WINDOW_SEC;

  const info = readBitNodeInfo(ns);
  const gangPossible = info?.node === 2 || (info?.sourceFiles["2"] ?? 0) >= 1;
  const expected: Expected[] = [
    { script: "development/metadata/supervisor.js", core: true },
    { script: "tools/log_rotator.js", core: true },
    { script: "development/metadata/reloader.js", core: false },
    { script: "development/metadata/player.js", core: true },
    { script: "development/metadata/scheduler_daemon.js", core: true },
    { script: "tools/program_shopper.js", core: true },
    { script: "development/metadata/faction_daemon.js", core: true },
    { script: "development/metadata/gang_daemon.js", core: false, when: gangPossible },
    { script: "development/metadata/sleeve_daemon.js", core: false, when: sleevesAvailable(info?.node, info?.sourceFiles) },
    { script: "development/metadata/hacknet_daemon.js", core: false },
    { script: "development/metadata/study_daemon.js", core: false },
    { script: "development/metadata/stock_daemon.js", core: false },
    { script: "development/metadata/monitoring_daemon.js", core: false },
    { script: "development/metadata/share_daemon.js", core: false },
  ];
  // Bootstrap replaces the whole system on a small home - nothing else is expected then.
  const running = ns.ps("home").map((p) => p.filename.replace(/^\//, ""));
  const bootstrapping = running.includes("bootstrap.js");

  const faction = readJson<FactionRepsFile>(ns, FACTION_REPS_PATH);
  const gang = readJson<GangStatusFile>(ns, GANG_STATUS_PATH);
  const gangState = readJson<{ casualties: number }>(ns, "/var/gang_state.txt");
  const gangConfig = readJson<{ maxCasualties?: number }>(ns, "/etc/gang.txt");
  const sleeves = readJson<SleevesFile>(ns, SLEEVES_PATH);
  const install = readInstallPending(ns);
  const savings = readSavings(ns);
  const cash = ns.getServerMoneyAvailable("home");

  const snapshot: StatusSnapshot = {
    nowMs: Date.now(),
    running,
    expected: bootstrapping ? [] : expected.filter((e) => e.when !== false).map(({ script, core }) => ({ script, core })),
    cash,
    rates: {
      hacking: ratePerMin(ns, "counter/hacking", windowSec),
      gang: ratePerMin(ns, "counter/gang", windowSec),
      gangExpenses: ratePerMin(ns, "counter/gang_expenses", windowSec),
      cash: ratePerMin(ns, "gauge/cash", windowSec),
      karma: ratePerMin(ns, "gauge/karma", windowSec, true),
    },
    hackingBaseline: ratePerMin(ns, "counter/hacking", BASELINE_WINDOW_SEC),
    savings: savings ? { amount: savings.amount, reason: savings.reason } : undefined,
    faction,
    gang,
    gangCasualties: gangState ? { casualties: gangState.casualties, maxCasualties: gangConfig?.maxCasualties ?? 1 } : undefined,
    sleeves,
    installPending: install,
    schedulerLogTail: ns.read(SCHEDULER_LOG).split("\n").filter(Boolean).slice(-SCHEDULER_LOG_LINES),
  };

  const findings = checkStatus(snapshot);
  const line = (f: Finding): string => `${f.level.padEnd(5)} ${f.message}`;
  const out: string[] = [];
  out.push(`=== Problems (${findings.filter((f) => f.level !== "info").length}) ===`);
  out.push(...(findings.length > 0 ? findings.map(line) : ["none"]));

  const rates = snapshot.rates;
  out.push("", `=== Summary (rates over ${Math.round(windowSec / 60)}m) ===`);
  out.push(
    `mode ${bootstrapping ? "BOOTSTRAP" : Approach[readApproach(ns)]}  BitNode ${info?.node ?? "?"}  cash ${money(cash)} ` +
      `(${rates.cash !== undefined ? `${money(rates.cash)}/min` : "no data"})`
  );
  out.push(`income/min: hacking ${money(rates.hacking)}  gang ${money(rates.gang)}  gang equipment ${money(rates.gangExpenses)}`);
  if (savings) out.push(`saving ${money(savings.amount)} for ${savings.reason}`);
  if (faction) {
    out.push(
      `player: ${faction.karmaCrime ? `crime - ${faction.karmaCrime}` : faction.workTarget ? `working for ${faction.workTarget}` : "no faction work"}` +
        `${faction.inviteAction ? `; invite: ${faction.inviteAction}` : ""}`
    );
    const targets = Object.entries(faction.repTargets ?? {}).map(([f, t]) => `${f} ${money((faction.reps[f] ?? 0)).slice(1)}/${money(t).slice(1)}`);
    if (targets.length > 0) out.push(`rep targets: ${targets.join(", ")}`);
  }
  if (gang) {
    out.push(
      `gang: territory ${(gang.territory * 100).toFixed(1)}%  odds ${(gang.worstWinChance * 100).toFixed(0)}%  ` +
        `${gang.engaged ? "engaged" : "not engaged"}  respect ${money(gang.respect).slice(1)}  casualties ${gangState?.casualties ?? "?"}`
    );
  }
  for (const s of sleeves?.sleeves ?? []) out.push(`sleeve ${s.index}: ${s.goal} (shock ${s.shock.toFixed(0)}, sync ${s.sync.toFixed(0)})`);
  if (install) out.push(`install pending: ${install.phase ?? "augments"} phase`);

  // Scheduler: target and its live state, batch rate, latest warning.
  const scheduler = summarizeScheduler(snapshot.schedulerLogTail);
  out.push("", "=== Scheduler ===");
  if (scheduler.target && ns.serverExists(scheduler.target)) {
    const t = scheduler.target;
    out.push(
      `target ${t}: security ${ns.getServerSecurityLevel(t).toFixed(2)}/${ns.getServerMinSecurityLevel(t).toFixed(2)} min, ` +
        `money ${money(ns.getServerMoneyAvailable(t))}/${money(ns.getServerMaxMoney(t))}`
    );
  } else {
    out.push("target: unknown (nothing in the recent log)");
  }
  const tuned = readJson<{ hackFraction: number; utilization: number; updatedAt: number }>(ns, "/var/scheduler_state.txt");
  if (tuned) {
    out.push(
      `hackFraction ${(tuned.hackFraction * 100).toFixed(1)}% (auto; worker RAM ${(tuned.utilization * 100).toFixed(0)}% used at last adjustment, ` +
        `${Math.round((Date.now() - tuned.updatedAt) / 60_000)}m ago)`
    );
  }
  out.push(
    `last ${snapshot.schedulerLogTail.length} log lines: ${scheduler.fired} batches fired` +
      `${scheduler.batchesPerMin !== undefined ? ` (~${scheduler.batchesPerMin.toFixed(1)}/min)` : ""}, ${scheduler.prep} prep, ` +
      `${scheduler.notHackable} not-hackable, ${scheduler.noFit} didn't-fit`
  );
  if (scheduler.lastWarning) out.push(`latest warning: ${scheduler.lastWarning}`);

  out.push("", "=== Fleet ===", ...fleetLines(ns));

  ns.tprintf("%s", out.join("\n"));
}
