import { NS } from "@ns";
import { readStoppedDaemons, STOPPED_DAEMONS_PATH } from "system/reload_plan";
import { readApproach } from "system/phase";
import { readBitNodeInfo } from "system/bitnode_info";
import { readInstallPending } from "system/install_handshake";
import { readSavings } from "system/savings";
import { LOG_BACKUP_SUFFIX } from "system/logs";
import { PENDING_BOOST_PATH, PendingBoost } from "factions/skill_progress";
import { averageRatePerMin, incomePerMin, listSeries, parseWindow, readSeries, windowPoints } from "system/monitoring/timeseries";
import { FACTION_REPS_PATH, FactionRepsFile } from "factions/faction_decisions";
import { GANG_STATUS_PATH, GangStatusFile } from "gang/gang_decisions";
import { HACKNET_STATUS_PATH, HacknetStatusFile } from "economy/hacknet_decisions";
import { SCHEDULER_TARGETS_PATH, SchedulerTargetsFile } from "hacking/hwgw";
import { Approach } from "system/rpc/scheduler";
import { SLEEVES_PATH, sleevesAvailable, SleevesFile } from "sleeves/sleeve_decisions";
import { checkStatus, Finding, formatMoney, StatusSnapshot, summarizeScheduler } from "tools/status_checks";

/**
 * One-screen health check of the whole system:
 *
 *   run tools/status.js [--window 10m] [--verbose] [--out /var/claude_out/status.txt]
 *
 * --verbose adds player stats, every faction's rep and favor, what blocks
 * each wanted invite, the scheduler's top targets, home RAM per script and
 * each daemon's latest warning or error (verboseLines).
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
const FACTION_LOG = "/var/log/home/faction_daemon.txt";

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
  const rate = series ? averageRatePerMin(series, Math.floor(Date.now() / 1000), windowSec) : undefined;
  return rate !== undefined && falling ? -rate : rate;
}

function money(n: number | undefined): string {
  return n === undefined ? "n/a" : formatMoney(n);
}

const WORKERS = [
  "hacking/workers/hack_worker.js",
  "hacking/workers/grow_worker.js",
  "hacking/workers/weaken_worker.js",
  "hacking/workers/share_worker.js",
  "system/bootstrap/bootstrap_worker.js",
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

/** Used share of all rooted servers' RAM, home included (as fleetLines reports it). */
function fleetUsage(ns: NS): number | undefined {
  let max = 0;
  let used = 0;
  for (const host of allServers(ns)) {
    if (!ns.hasRootAccess(host)) continue;
    max += ns.getServerMaxRam(host);
    used += ns.getServerUsedRam(host);
  }
  return max > 0 ? used / max : undefined;
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

const TARGET_WEIGHTS_PATH = "/var/target_selector/weights.txt";

/** The --verbose sections: details otherwise only found by cat-ing files and logs. */
function verboseLines(ns: NS, faction: FactionRepsFile | undefined, pendingCount: number | undefined): string[] {
  const out: string[] = [];
  const short = (n: number): string => formatMoney(n).slice(1);

  const p = ns.getPlayer();
  out.push("", "=== Player ===");
  out.push(
    `hacking ${p.skills.hacking}  str ${p.skills.strength}  def ${p.skills.defense}  dex ${p.skills.dexterity}  agi ${p.skills.agility}  ` +
      `cha ${p.skills.charisma}  int ${p.skills.intelligence}  karma ${p.karma.toFixed(0)}  city ${p.city}  ` +
      `installed augs ${faction?.installedAugs ?? "?"}  pending ${pendingCount ?? "?"}`
  );
  const programs = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "Formulas.exe"];
  out.push(`programs: ${programs.map((p) => `${p.replace(".exe", "")} ${ns.fileExists(p, "home") ? "yes" : "NO"}`).join("  ")}`);

  if (faction) {
    out.push("", "=== Factions (joined) ===");
    const donatable = new Set(faction.donatable ?? []);
    for (const name of Object.keys(faction.reps).sort()) {
      const target = faction.repTargets?.[name];
      out.push(
        `${name.padEnd(28)} rep ${short(faction.reps[name] ?? 0).padStart(7)}  favor ${(faction.favors?.[name] ?? 0).toFixed(0).padStart(3)}` +
          `${donatable.has(name) ? " (donations)" : ""}${target ? `  target ${short(target)}` : ""}${faction.workTarget === name ? "  <- player" : ""}`
      );
    }
    const blockers = Object.entries(faction.inviteBlockers ?? {});
    if (blockers.length > 0) {
      out.push("", "=== Wanted invites (not joined) ===");
      for (const [name, missing] of blockers) out.push(`${name}: ${missing.length > 0 ? missing.join("; ") : "nothing missing - invite pending"}`);
    }
  }

  const weightsFile = readJson<{
    weights: { hostname: string; weight: number }[];
    computedAt?: number;
    hackingLevel?: number;
    scorer?: string;
    factors?: Record<string, { maxMoney: number; chance: number; discount: number }>;
  }>(ns, TARGET_WEIGHTS_PATH);
  const weights = weightsFile?.weights ?? [];
  if (weights.length > 0) {
    const age = weightsFile?.computedAt ? `${Math.round((Date.now() - weightsFile.computedAt) / 60_000)}m ago` : "unknown age";
    out.push(
      "",
      `=== Target ranking (top 8 of ${weights.length}; computed ${age} at hacking ${weightsFile?.hackingLevel ?? "?"}, scorer ${weightsFile?.scorer ?? "old"}) ===`
    );
    for (const w of weights.slice(0, 8)) {
      out.push(
        `${w.hostname.padEnd(20)} weight ${w.weight.toExponential(2)}  rooted ${ns.hasRootAccess(w.hostname) ? "yes" : "no"}  ` +
          `security ${ns.getServerSecurityLevel(w.hostname).toFixed(1)}/${ns.getServerMinSecurityLevel(w.hostname).toFixed(1)}  ` +
          `money ${formatMoney(ns.getServerMoneyAvailable(w.hostname))}/${formatMoney(ns.getServerMaxMoney(w.hostname))}`
      );
    }
  }

  // Where the richest servers landed, and why: a big server sinking out of
  // the top 8 went unnoticed twice.
  const factors = weightsFile?.factors;
  if (factors && weights.length > 0) {
    const richest = Object.entries(factors)
      .sort((a, b) => b[1].maxMoney - a[1].maxMoney)
      .slice(0, 3);
    out.push("richest servers:");
    for (const [host, f] of richest) {
      const rank = weights.findIndex((w) => w.hostname === host) + 1;
      out.push(
        `  ${host.padEnd(18)} rank ${rank || "-"}  max ${formatMoney(f.maxMoney)}  chance ${f.chance.toFixed(2)}  prep discount ${f.discount.toFixed(3)}  ` +
          `rooted ${ns.hasRootAccess(host) ? "yes" : "no"}  security ${ns.getServerSecurityLevel(host).toFixed(1)}/${ns.getServerMinSecurityLevel(host).toFixed(1)}`
      );
    }
  }

  out.push("", "=== Home RAM by script ===");
  const byScript = new Map<string, number>();
  for (const proc of ns.ps("home")) {
    const file = proc.filename.replace(/^\//, "");
    byScript.set(file, (byScript.get(file) ?? 0) + ns.getScriptRam(proc.filename, "home") * proc.threads);
  }
  const max = ns.getServerMaxRam("home");
  out.push(`${(ns.getServerUsedRam("home") / 1024).toFixed(2)} of ${(max / 1024).toFixed(2)} TB used`);
  for (const [file, ram] of [...byScript.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`  ${file.padEnd(48)} ${ram.toFixed(1)} GB`);

  out.push("", "=== Latest warning/error per daemon log ===");
  let any = false;
  for (const file of ns.ls("home", "/var/log/home/")) {
    if (file.endsWith(`${LOG_BACKUP_SUFFIX}.txt`) || !file.endsWith(".txt")) continue;
    const last = ns.read(file).split("\n").reverse().find((line) => /\[(WARN|ERROR)/.test(line));
    if (last) {
      any = true;
      out.push(`${file.replace(/^.*\//, "").replace(/\.txt$/, "")}: ${last.length > 220 ? `${last.slice(0, 220)}...` : last}`);
    }
  }
  if (!any) out.push("none");
  return out;
}

export async function main(ns: NS): Promise<void> {
  const args = ns.args.map(String);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const windowIdx = args.indexOf("--window");
  const windowSec = (windowIdx >= 0 ? parseWindow(args[windowIdx + 1] ?? "") : undefined) ?? DEFAULT_WINDOW_SEC;

  const info = readBitNodeInfo(ns);
  const gangPossible = info?.node === 2 || (info?.sourceFiles["2"] ?? 0) >= 1;
  const expected: Expected[] = [
    { script: "system/supervisor.js", core: true },
    { script: "system/log_rotator.js", core: true },
    { script: "system/reloader.js", core: false },
    { script: "system/player.js", core: true },
    { script: "hacking/scheduler_daemon.js", core: true },
    { script: "hacking/program_shopper.js", core: true },
    { script: "factions/faction_daemon.js", core: true },
    { script: "gang/gang_daemon.js", core: false, when: gangPossible },
    { script: "sleeves/sleeve_daemon.js", core: false, when: sleevesAvailable(info?.node, info?.sourceFiles) },
    { script: "economy/hacknet_daemon.js", core: false },
    { script: "factions/study_daemon.js", core: false },
    { script: "economy/stock_daemon.js", core: false },
    { script: "system/monitoring/monitoring_daemon.js", core: false },
    { script: "hacking/share_daemon.js", core: false },
  ];
  // Bootstrap replaces the whole system on a small home - nothing else is expected then.
  const running = ns.ps("home").map((p) => p.filename.replace(/^\//, ""));
  const bootstrapping = running.includes("system/bootstrap/bootstrap.js");
  const stopped = readStoppedDaemons(ns.read(STOPPED_DAEMONS_PATH));

  const faction = readJson<FactionRepsFile>(ns, FACTION_REPS_PATH);
  // A gang file from an earlier BitNode describes a gang that no longer
  // exists (the new run hasn't made one yet) - ignore it.
  const gangFile = readJson<GangStatusFile>(ns, GANG_STATUS_PATH);
  const gang = gangFile && info && gangFile.writtenAt < info.lastNodeReset ? undefined : gangFile;
  const gangState = readJson<{ casualties: number }>(ns, "/var/gang_state.txt");
  const gangConfig = readJson<{ maxCasualties?: number }>(ns, "/etc/gang.txt");
  const sleeves = readJson<SleevesFile>(ns, SLEEVES_PATH);
  const install = readInstallPending(ns);
  const savings = readSavings(ns);
  const cash = ns.getServerMoneyAvailable("home");
  const approach = readApproach(ns);
  const factionConfig = readJson<{ autoPurchaseAugmentations?: boolean; autoInstall?: boolean; maxFocusWaitMinutes?: number; sleeveSaveMinutes?: number }>(
    ns,
    "/etc/faction.txt"
  );
  const pendingBoost = readJson<PendingBoost>(ns, PENDING_BOOST_PATH);

  const snapshot: StatusSnapshot = {
    nowMs: Date.now(),
    running,
    // Daemons stopped on purpose (tools/kill.js) aren't missing.
    expected: bootstrapping
      ? []
      : expected.filter((e) => e.when !== false && !stopped.includes(e.script)).map(({ script, core }) => ({ script, core })),
    cash,
    rates: {
      hacking: ratePerMin(ns, "counter/hacking", windowSec),
      gang: ratePerMin(ns, "counter/gang", windowSec),
      gangExpenses: ratePerMin(ns, "counter/gang_expenses", windowSec),
      cash: ratePerMin(ns, "gauge/cash", windowSec),
      karma: ratePerMin(ns, "gauge/karma", windowSec, true),
      netWorth: ratePerMin(ns, "gauge/net_worth", windowSec),
    },
    hackingBaseline: ratePerMin(ns, "counter/hacking", BASELINE_WINDOW_SEC),
    // Expense counters are cumulative negatives, so spending shows as a falling rate.
    spending: listSeries(ns)
      .filter((id) => id.startsWith("counter/") && id !== "counter/total")
      .map((id) => ({ category: id.slice("counter/".length), perMin: -(ratePerMin(ns, id, windowSec) ?? 0) }))
      .filter((x) => x.perMin > 0)
      .sort((a, b) => b.perMin - a.perMin),
    savings: savings ? { amount: savings.amount, reason: savings.reason } : undefined,
    faction,
    gang,
    gangCasualties: gangState ? { casualties: gangState.casualties, maxCasualties: gangConfig?.maxCasualties ?? 1 } : undefined,
    sleeves,
    installPending: install,
    fleetUsedFraction: fleetUsage(ns),
    missingPrograms: ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "Formulas.exe"].filter((p) => !ns.fileExists(p, "home")),
    hacknetWrittenAt: readJson<{ writtenAt: number }>(ns, HACKNET_STATUS_PATH)?.writtenAt,
    augmentLoop: {
      augmentsMode: approach === Approach.AUGMENTS,
      autoPurchase: factionConfig?.autoPurchaseAugmentations === true,
      autoInstall: factionConfig?.autoInstall === true,
      pending: pendingBoost?.count ?? 0,
    },
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
    `mode ${bootstrapping ? "BOOTSTRAP" : Approach[approach]}  BitNode ${info?.node ?? "?"}  cash ${money(cash)} ` +
      `(${rates.cash !== undefined ? `${money(rates.cash)}/min` : "no data"})`
  );
  out.push(`income/min: hacking ${money(rates.hacking)}  gang ${money(rates.gang)}  gang equipment ${money(rates.gangExpenses)}`);
  // Only a recent sample: without TIX access nothing new is recorded, and
  // the last value can be from an earlier BitNode.
  const stockSeries = readSeries(ns, "gauge/stock_value");
  const stockValue = stockSeries
    ? windowPoints(stockSeries, Math.floor(Date.now() / 1000), 5 * 60).filter((p): p is { t: number; v: number } => p.v !== null).pop()?.v
    : undefined;
  if (stockValue !== undefined && stockValue > 0) {
    out.push(
      `net worth ${money(cash + stockValue)} (${rates.netWorth !== undefined ? `${money(rates.netWorth)}/min` : "no data"}), ` +
        `of which stocks ${money(stockValue)}`
    );
  }
  const spent = (snapshot.spending ?? []).map((x) => `${x.category} ${money(x.perMin)}`);
  if (spent.length > 0) out.push(`spending/min: ${spent.join("  ")}`);
  if (savings) out.push(`saving ${money(savings.amount)} for ${savings.reason}`);
  const study = readJson<{ kind: string }>(ns, "/var/study_activity.txt");
  const slot = readJson<{ free: boolean }>(ns, "/var/work_slot.txt");
  const studyLine = slot?.free
    ? `no faction needs grinding (favor targets met) - ${study?.kind === "gym" ? "training at the gym" : study?.kind === "class" ? "studying" : "training/studying"}`
    : "no faction work";
  if (faction) {
    out.push(
      `player: ${faction.karmaCrime ? `crime - ${faction.karmaCrime}` : faction.workTarget ? `working for ${faction.workTarget}` : studyLine}` +
        `${faction.inviteAction ? `; invite: ${faction.inviteAction}` : ""}`
    );
    const eta = (m: number): string => (m >= 120 ? `${(m / 60).toFixed(1)}h` : `${m.toFixed(0)}m`);
    for (const g of faction.grinds ?? []) {
      out.push(
        `grind: ${g.faction} ${money(g.repPerMin).slice(1)} rep/min, ${eta(g.etaMinutes)} to its favor target; ` +
          `install now -> favor ${g.favor.toFixed(0)}->${g.installFavor.toFixed(0)}, ${eta(g.installEtaMinutes)}`
      );
    }
    if (faction.grinds && faction.grinds.length > 0) {
      const now = Math.max(...faction.grinds.map((g) => g.etaMinutes));
      const after = Math.max(...faction.grinds.map((g) => g.installEtaMinutes));
      out.push(`grind overall: last favor target in ${eta(now)}; with an install now ${eta(after)}${after < now ? " - installing pays" : ""}`);
    }
    const companies = (faction.companyTargets ?? []).map((c) => `${c.faction} ${money(c.rep).slice(1)}/${money(c.needed).slice(1)}`);
    if (companies.length > 0) out.push(`company rep toward invites: ${companies.join(", ")}`);
    const targets = Object.entries(faction.repTargets ?? {}).map(([f, t]) => `${f} ${money((faction.reps[f] ?? 0)).slice(1)}/${money(t).slice(1)}`);
    if (targets.length > 0) out.push(`rep targets: ${targets.join(", ")}`);
  }
  if (gang) {
    out.push(
      `gang: territory ${(gang.territory * 100).toFixed(1)}%  odds ${(gang.worstWinChance * 100).toFixed(0)}%  ` +
        `${gang.engaged ? "engaged" : "not engaged"}  respect ${money(gang.respect).slice(1)}  casualties ${gangState?.casualties ?? "?"}`
    );
  }
  const hacknet = readJson<HacknetStatusFile>(ns, HACKNET_STATUS_PATH);
  if (hacknet) {
    const policy = { none: "not buying (install loop)", income: "buying with up to incomeShare (5%) of income", payback: "buying on payback" }[hacknet.policy];
    out.push(
      `hacknet: ${hacknet.nodes}/${hacknet.maxNodes} ${hacknet.servers ? "servers" : "nodes"}, ` +
        (hacknet.servers
          ? `${hacknet.productionPerSec.toFixed(1)} hashes/s, ${hacknet.hashes.toFixed(0)}/${hacknet.hashCapacity.toFixed(0)} stored, `
          : `${money(hacknet.productionPerSec * 60)}/min, `) +
        `${policy}${hacknet.hashSpending ? `; hashes ${hacknet.hashSpending}` : ""}`
    );
  }
  for (const s of sleeves?.sleeves ?? [])
    out.push(`sleeve ${s.index}: ${s.goal} (shock ${s.shock.toFixed(0)}, sync ${s.sync.toFixed(0)}${s.memory !== undefined ? `, memory ${s.memory}` : ""}${s.augs !== undefined ? `, ${s.augs} augs` : ""})`);
  if (sleeves?.shop) {
    const cost = sleeves.shop.nextSleeveCost;
    const next = Number.isFinite(cost) ? money(cost) : "none left to buy";
    // How far away it is, and the income at which the faction daemon starts saving for it (sleeveSavings).
    const income = incomePerMin(ns, windowSec);
    const saveMinutes = factionConfig?.sleeveSaveMinutes ?? 480;
    const eta =
      Number.isFinite(cost) && income !== undefined && income > 0
        ? `; ~${((Math.max(0, cost - cash) / income) / 60).toFixed(1)}h of current income, saving starts at ${money(cost / saveMinutes)}/min`
        : "";
    out.push(`sleeve shop (The Covenant): next sleeve ${next}${eta}${sleeves.shop.lastMessage ? `; game says: ${sleeves.shop.lastMessage}` : ""}`);
  }
  const sinceInstall = Math.round((Date.now() - ns.getResetInfo().lastAugReset) / 60_000);
  out.push(
    `augmentations: ${pendingBoost?.count ?? "?"} pending, last install ${sinceInstall}m ago, ` +
      `autoInstall ${factionConfig?.autoInstall ? "on" : "off"}, focus wait limit ${factionConfig?.maxFocusWaitMinutes ?? 5}m`
  );
  // The faction daemon's latest decision (money, focus, purchase) and last buy, straight from its log.
  const factionLog = ns.read(FACTION_LOG).split("\n");
  const lastOf = (marker: string): string | undefined => [...factionLog].reverse().find((l) => l.includes(marker));
  const factionTick = lastOf("[Faction] tick:");
  const lastBuy = lastOf("[Faction] Purchased ");
  if (factionTick) out.push(`faction daemon: ${factionTick.slice(factionTick.indexOf("tick:") + 6)}`);
  out.push(`last augmentation bought: ${lastBuy ? lastBuy.slice(lastBuy.indexOf("Purchased ")) : "none in the current log"}`);
  if (install) out.push(`install pending: ${install.phase ?? "augments"} phase`);

  // Scheduler: target and its live state, batch rate, latest warning.
  const scheduler = summarizeScheduler(snapshot.schedulerLogTail);
  out.push("", "=== Scheduler ===");
  // The scheduler batches several targets; list each one batched in the window.
  for (const t of scheduler.targets.slice(0, 8)) {
    if (!ns.serverExists(t) || t === scheduler.target) continue;
    out.push(
      `also batching ${t}: security ${ns.getServerSecurityLevel(t).toFixed(2)}/${ns.getServerMinSecurityLevel(t).toFixed(2)} min, ` +
        `money ${money(ns.getServerMoneyAvailable(t))}/${money(ns.getServerMaxMoney(t))}`
    );
  }
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
  // Income per target, from the scheduler's own bookkeeping (batches in the
  // last minute x planned take per batch).
  const perTarget = readJson<SchedulerTargetsFile>(ns, SCHEDULER_TARGETS_PATH)?.targets ?? [];
  const totalTargetIncome = perTarget.reduce((sum, t) => sum + t.incomePerMin, 0);
  if (perTarget.length > 0) {
    const prepping = perTarget.filter((t) => t.state === "prepping").length;
    out.push(`targets: ${perTarget.length} (${prepping} prepping); planned hacking income ${money(totalTargetIncome)}/min`);
    for (const t of [...perTarget].sort((a, b) => b.incomePerMin - a.incomePerMin).slice(0, verbose ? 10 : 5)) {
      const share = totalTargetIncome > 0 ? (t.incomePerMin / totalTargetIncome) * 100 : 0;
      out.push(
        `  ${t.host.padEnd(18)} ${t.state.padEnd(9)} ${String(t.batchesPerMin).padStart(4)} batches/min x ${money(t.takePerBatch)} = ${money(t.incomePerMin)}/min (${share.toFixed(0)}%)`
      );
    }
  }

  out.push("", "=== Fleet ===", ...fleetLines(ns));
  if (verbose) out.push(...verboseLines(ns, faction, pendingBoost?.count));

  ns.tprintf("%s", out.join("\n"));
  // --out <file>: the same report as a file, for build/bridge.mjs to copy
  // out of the game (e.g. /var/claude_out/status.txt).
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (outFile) ns.write(outFile, `${new Date().toISOString()}\n${out.join("\n")}\n`, "w");
}
