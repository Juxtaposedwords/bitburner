import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "system/logs";
import { appendPoint, DEFAULT_CAPACITY, DEFAULT_STEP_SECONDS, readSeries, writeSeries } from "system/monitoring/timeseries";
import { FACTION_REPS_PATH, FactionRepsFile, repSeriesId } from "factions/faction_decisions";
import { GANG_STATUS_PATH, GangStatusFile } from "gang/gang_decisions";
import * as player_metadata_pb from "system/rpc/player_metadata";
import * as server_metadata_pb from "system/rpc/server_metadata";
import { SCHEDULER_TARGETS_PATH, SchedulerTargetsFile } from "hacking/hwgw";
import { PHASE_PATH, PhaseFile } from "system/phase";
import { readSavings } from "system/savings";
import { PENDING_BOOST_PATH, PendingBoost } from "factions/skill_progress";
import { SLEEVES_PATH, SleevesFile } from "sleeves/sleeve_decisions";
import { appendMilestones, dueMilestones, MILESTONES_PATH, recordedFor } from "system/monitoring/milestones";
import { readBitNodeInfo } from "system/bitnode_info";

/**
 * Samples the economy once a minute into fixed-size time series under
 * /var/monitoring/ (see system/monitoring/timeseries.ts), read back by
 * tools/monitor.ts. The only writer of every file there, so no two scripts
 * ever write the same file.
 *
 * Counters come straight from ns.getMoneySources().sinceStart - the game's
 * own cumulative per-category totals - so no purchase call site anywhere
 * needs instrumenting. sinceStart rather than sinceInstall so installing
 * augmentations doesn't reset them. Every nonzero category is recorded as
 * counter/<key> with nothing hardcoded; tools/monitor.ts decides income vs.
 * spend from the sign of the change.
 *
 * Deliberately left out of wipe_data.ts's WIPE_PREFIXES, so history
 * survives test_restart.js - a restart shows up as a gap of nulls.
 */
const TICK_INTERVAL_MS = DEFAULT_STEP_SECONDS * 1000;
// faction_daemon.ts writes every 5s; allow a few missed writes.
const REPS_MAX_AGE_MS = 60_000;
// gang_daemon.ts writes every 5s too.
const STATUS_MAX_AGE_MS = 60_000;

function record(ns: NS, id: string, t: number, value: number): void {
  writeSeries(ns, id, appendPoint(readSeries(ns, id), t, value, DEFAULT_STEP_SECONDS, DEFAULT_CAPACITY));
}

/** Market value of long positions at the current bid. undefined without TIX API access, since the other ns.stock calls need it. */
function stockValue(ns: NS): number | undefined {
  if (!ns.stock.hasTixApiAccess()) return undefined;
  let total = 0;
  for (const sym of ns.stock.getSymbols()) {
    const [sharesLong] = ns.stock.getPosition(sym);
    if (sharesLong > 0) total += sharesLong * ns.stock.getBidPrice(sym);
  }
  return total;
}

/**
 * Hacknet economy: production rate, node count and, for Hacknet Servers,
 * stored hashes against capacity. All gauges: tools/monitor.ts treats every
 * counter as money. `production` is hashes/s for servers and $/s for plain
 * nodes, so the rate series is named after whichever this is.
 */
function recordHacknet(ns: NS, t: number): string {
  const count = ns.hacknet.numNodes();
  if (count === 0) return "hacknet=none";
  const isServer = ns.hacknet.hashCapacity() > 0;
  const unit = isServer ? "hash" : "hacknet_money";
  let rate = 0;
  for (let i = 0; i < count; i++) rate += ns.hacknet.getNodeStats(i).production;
  record(ns, "gauge/hacknet_nodes", t, count);
  record(ns, `gauge/${unit}_rate`, t, rate);
  if (isServer) {
    record(ns, "gauge/hashes", t, ns.hacknet.numHashes());
    record(ns, "gauge/hash_capacity", t, ns.hacknet.hashCapacity());
  }
  return `hacknet=${count} ${unit}_rate=${rate.toFixed(2)}/s`;
}

/**
 * One gauge per joined faction from faction_daemon.ts's FACTION_REPS_PATH.
 * Skipped when that file is stale (faction daemon not running), so a gap
 * shows instead of a flat line of old values.
 */
function recordReps(ns: NS, t: number): string {
  const raw = ns.read(FACTION_REPS_PATH);
  if (!raw) return "reps=none";
  let file: FactionRepsFile;
  try {
    file = JSON.parse(raw) as FactionRepsFile;
  } catch {
    return "reps=unreadable";
  }
  if (Date.now() - file.writtenAt > REPS_MAX_AGE_MS) return "reps=stale";
  for (const [faction, rep] of Object.entries(file.reps)) record(ns, repSeriesId(faction), t, rep);
  return `reps=${Object.keys(file.reps).length} workTarget=${file.workTarget ?? "none"}`;
}

/**
 * Gang power, odds and territory from gang_daemon.ts's GANG_STATUS_PATH,
 * for judging whether putting members on Territory Warfare pays off
 * (income itself is already counter/gang). Percentages are stored as 0-100
 * so the summary reads naturally. Skipped when the file is stale.
 */
function recordGang(ns: NS, t: number): string {
  const raw = ns.read(GANG_STATUS_PATH);
  if (!raw) return "gang=none";
  let s: GangStatusFile;
  try {
    s = JSON.parse(raw) as GangStatusFile;
  } catch {
    return "gang=unreadable";
  }
  if (Date.now() - s.writtenAt > STATUS_MAX_AGE_MS) return "gang=stale";
  record(ns, "gauge/gang_power", t, s.power);
  record(ns, "gauge/gang_rival_power", t, s.strongestRivalPower);
  record(ns, "gauge/gang_win_chance_pct", t, s.worstWinChance * 100);
  record(ns, "gauge/gang_territory_pct", t, s.territory * 100);
  record(ns, "gauge/gang_respect", t, s.respect);
  record(ns, "gauge/gang_warfare_members", t, s.territoryWarfareMembers);
  return `gang winChance=${(s.worstWinChance * 100).toFixed(1)}% territory=${(s.territory * 100).toFixed(1)}%`;
}

/** Reads a JSON status file another daemon publishes; undefined if missing, corrupt or older than STATUS_MAX_AGE_MS. */
function readStatus<T extends { writtenAt: number }>(ns: NS, path: string): T | undefined {
  try {
    const file = JSON.parse(ns.read(path) || "null") as T | null;
    return file && Date.now() - file.writtenAt <= STATUS_MAX_AGE_MS ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Every server reachable from home. */
function scanAll(ns: NS): string[] {
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
 * The system's own behavior, for judging changes from the trends: the
 * hacking pipeline (scheduler_targets), fleet RAM use, the phase, savings,
 * augmentation progress and what the sleeves do - all from files the
 * daemons already publish, plus one network scan.
 */
function recordSystem(ns: NS, t: number): string {
  const parts: string[] = [];
  const sched = readStatus<SchedulerTargetsFile>(ns, SCHEDULER_TARGETS_PATH);
  if (sched) {
    const planned = sched.targets.reduce((sum, x) => sum + x.incomePerMin, 0);
    const top = sched.targets.reduce((a, b) => (b.incomePerMin > a.incomePerMin ? b : a), sched.targets[0]);
    record(ns, "gauge/planned_hacking_per_min", t, planned);
    record(ns, "gauge/batches_per_min", t, sched.targets.reduce((sum, x) => sum + x.batchesPerMin, 0));
    record(ns, "gauge/targets_batching", t, sched.targets.filter((x) => x.state === "batching").length);
    record(ns, "gauge/targets_prepping", t, sched.targets.filter((x) => x.state === "prepping").length);
    record(ns, "gauge/drifts_per_min", t, sched.driftsLastMin ?? 0);
    if (top && planned > 0) record(ns, "gauge/top_target_share_pct", t, (top.incomePerMin / planned) * 100);
    parts.push(`planned=$${planned.toExponential(2)}/min`);
  }
  let max = 0;
  let used = 0;
  for (const host of scanAll(ns)) {
    if (!ns.hasRootAccess(host)) continue;
    max += ns.getServerMaxRam(host);
    used += ns.getServerUsedRam(host);
  }
  if (max > 0) record(ns, "gauge/fleet_used_pct", t, (used / max) * 100);
  const phase = readStatus<PhaseFile>(ns, PHASE_PATH);
  if (phase) record(ns, "gauge/phase", t, phase.approach);
  const savings = readSavings(ns);
  record(ns, "gauge/savings_target", t, savings?.amount ?? 0);
  const faction = readStatus<FactionRepsFile>(ns, FACTION_REPS_PATH);
  if (faction?.installedAugs !== undefined) record(ns, "gauge/augs_installed", t, faction.installedAugs);
  // The finish line and the favor that gates it (system/phase.ts).
  if (faction?.hackingMult !== undefined) record(ns, "gauge/hacking_mult", t, faction.hackingMult);
  if (faction?.requiredHackingMult !== undefined) record(ns, "gauge/required_hacking_mult", t, faction.requiredHackingMult);
  const favorTarget = faction?.favorPlan?.[0];
  if (favorTarget && favorTarget.target > 0) record(ns, "gauge/favor_target_pct", t, Math.min(100, (favorTarget.rep / favorTarget.target) * 100));
  if (faction?.favors) record(ns, "gauge/best_favor", t, Math.max(0, ...Object.values(faction.favors)));
  if (faction?.donatable) record(ns, "gauge/donatable_factions", t, faction.donatable.length);
  const pending = readStatus<PendingBoost>(ns, PENDING_BOOST_PATH);
  if (pending) record(ns, "gauge/augs_pending", t, pending.count);
  const sleeves = readStatus<SleevesFile>(ns, SLEEVES_PATH);
  if (sleeves && sleeves.sleeves.length > 0) {
    record(ns, "gauge/sleeves", t, sleeves.sleeves.length);
    record(ns, "gauge/sleeves_on_faction", t, sleeves.sleeves.filter((s) => s.goal.startsWith("faction work")).length);
    record(ns, "gauge/sleeve_avg_shock", t, sleeves.sleeves.reduce((sum, s) => sum + s.shock, 0) / sleeves.sleeves.length);
  }
  return parts.join(" ");
}

/** Appends the run milestones this sample shows for the first time (system/monitoring/milestones.ts). */
function recordMilestones(ns: NS): string {
  const info = readBitNodeInfo(ns);
  if (!info) return "";
  const now = Date.now();
  const supervisor = ns.getRunningScript("system/supervisor.js", "home");
  const faction = readStatus<FactionRepsFile>(ns, FACTION_REPS_PATH);
  const phase = readStatus<PhaseFile>(ns, PHASE_PATH);
  const raw = ns.read(MILESTONES_PATH);
  const due = dueMilestones(recordedFor(raw, info.lastNodeReset), {
    now,
    node: info.node,
    runStart: info.lastNodeReset,
    supervisorSince: supervisor ? now - supervisor.onlineRunningTime * 1000 : undefined,
    factionDaemon: faction !== undefined,
    sleeveGoals: readStatus<SleevesFile>(ns, SLEEVES_PATH)?.sleeves.map((s) => s.goal) ?? [],
    inGang: readStatus<GangStatusFile>(ns, GANG_STATUS_PATH) !== undefined,
    donatable: faction?.donatable?.length ?? 0,
    phase: phase && phase.writtenAt >= info.lastNodeReset ? phase.approach : undefined,
  });
  if (due.length === 0) return "";
  ns.write(MILESTONES_PATH, appendMilestones(raw, due), "w");
  return `milestones=${due.map((m) => `${m.milestone}@${m.hours.toFixed(2)}h`).join(",")}`;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Monitoring", LOG_LEVEL.DEBUG);
  await log.info("=== Monitoring sampler online ===");

  while (true) {
    const t = Math.floor(Date.now() / 1000);

    let counters = 0;
    for (const [key, value] of Object.entries(ns.getMoneySources().sinceStart)) {
      // "total" is the net of every category - tools/monitor.ts shows net
      // change via the cash gauge instead.
      if (key === "total" || value === 0) continue;
      record(ns, `counter/${key}`, t, value);
      counters++;
    }

    const playerRes = await player_metadata_pb
      .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
      .GetPlayerMetadata({});
    const cash = playerRes.data?.player?.money ?? 0;
    record(ns, "gauge/cash", t, cash);
    record(ns, "gauge/hacking_level", t, playerRes.data?.player?.hackingLevel ?? 0);
    const hackingExp = playerRes.data?.player?.hackingExp;
    if (hackingExp !== undefined) record(ns, "gauge/hacking_exp", t, hackingExp);
    const karma = playerRes.data?.player?.karma;
    if (karma !== undefined) record(ns, "gauge/karma", t, karma);

    const stock = stockValue(ns);
    if (stock !== undefined) record(ns, "gauge/stock_value", t, stock);
    record(ns, "gauge/net_worth", t, cash + (stock ?? 0));

    const hacknet = recordHacknet(ns, t);
    const reps = recordReps(ns, t);
    const gang = recordGang(ns, t);
    const system = recordSystem(ns, t);
    const milestones = recordMilestones(ns);

    await log.debug(`[Monitoring] sampled ${counters} counter(s), cash=$${cash.toFixed(0)} stock=$${(stock ?? 0).toFixed(0)} ${hacknet} ${reps} ${gang} ${system} ${milestones}`);

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
