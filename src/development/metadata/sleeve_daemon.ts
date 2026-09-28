import { NS } from "@ns";
import { readApproach } from "development/libraries/approach";
import { readBitNodeInfo } from "development/libraries/bitnode_info";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { FACTION_REPS_PATH, FactionRepsFile } from "development/metadata/faction_decisions";
import { GANG_KARMA_REQUIREMENT, karmaBlocksGang } from "development/metadata/gang_decisions";
import { Approach } from "development/metadata/scheduler";
import {
  bestCrimeBy,
  decideSleeveGoals,
  describeGoal,
  SleeveGoal,
  SleeveMemory,
  SLEEVE_STATE_PATH,
  sleevesAvailable,
  SLEEVES_PATH,
  SleevesFile,
  syncPaysOff,
  taskMatchesGoal,
  updateSyncRate,
} from "development/metadata/sleeve_decisions";

type CrimeTypeType = Parameters<NS["sleeve"]["setToCommitCrime"]>[1];
type FactionNameType = Parameters<NS["sleeve"]["setToFactionWork"]>[1];
type FactionWorkTypeType = Parameters<NS["sleeve"]["setToFactionWork"]>[2];

/**
 * Runs every sleeve (see sleeve_decisions.ts for the priorities): gang karma
 * first, then shock recovery and sync, then rep at factions still short of a
 * target (faction_daemon.ts's repTargets in /var/faction_reps.txt), else
 * crime for money. Crime and work types are chosen by formula against each
 * sleeve's own stats when Formulas.exe is owned. Writes /var/sleeves.txt.
 *
 * Only launched by boot.ts when sleeves exist (BitNode 10 or Source-File
 * 10) - ns.sleeve throws otherwise. Every sleeve function costs 4 GB, which
 * a big home absorbs easily; it launches after the income daemons.
 */
type SleeveConfig = { enabled: boolean; maxShock: number; minSync: number };

const DEFAULT_CONFIG: SleeveConfig = { enabled: true, maxShock: 0, minSync: 100 };
const CONFIG_PATH = "/etc/sleeve.txt";
const TICK_INTERVAL_MS = 10_000;
// faction_daemon.ts writes every 5s; allow a few missed writes.
const REPS_MAX_AGE_MS = 60_000;
// Used without Formulas.exe, when crimes can't be ranked per sleeve.
const FALLBACK_CRIME = "Mug";

function readRepGaps(ns: NS): { repGaps: Record<string, number>; playerFaction?: string } {
  const raw = ns.read(FACTION_REPS_PATH);
  if (!raw) return { repGaps: {} };
  try {
    const file = JSON.parse(raw) as FactionRepsFile;
    if (Date.now() - file.writtenAt > REPS_MAX_AGE_MS) return { repGaps: {} };
    const repGaps: Record<string, number> = {};
    for (const [faction, target] of Object.entries(file.repTargets ?? {})) repGaps[faction] = target - (file.reps[faction] ?? 0);
    return { repGaps, playerFaction: file.workTarget };
  } catch {
    return { repGaps: {} };
  }
}

/** Best crime for sleeve `index` by `metric` (karma or money) using its own success chance; the fallback without Formulas.exe. */
function crimeFor(ns: NS, index: number, metric: "karma" | "money"): string {
  if (!ns.fileExists("Formulas.exe", "home")) return FALLBACK_CRIME;
  const person = ns.sleeve.getSleeve(index);
  const best = bestCrimeBy(
    Object.values(ns.enums.CrimeType).map((crime) => {
      const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
      return {
        crime,
        value: metric === "karma" ? stats.karma : stats.money,
        timeMs: stats.time,
        successChance: ns.formulas.work.crimeSuccessChance(person, crime as CrimeTypeType),
      };
    })
  );
  return best ?? FALLBACK_CRIME;
}

/** The work type earning sleeve `index` the most rep at `faction` (favor scales every type alike, so 0 is used). */
function workTypeFor(ns: NS, index: number, faction: string): string | undefined {
  const types = ns.singularity.getFactionWorkTypes(faction as FactionNameType);
  if (!ns.fileExists("Formulas.exe", "home")) return types.includes("hacking") ? "hacking" : types[0];
  const person = ns.sleeve.getSleeve(index);
  let best: { type: string; rep: number } | undefined;
  for (const type of types) {
    const rep = ns.formulas.work.factionGains(person, type, 0).reputation;
    if (!best || rep > best.rep) best = { type, rep };
  }
  return best?.type;
}

/** Starts `goal` on sleeve `index`; false if the game refused (e.g. a faction another worker already has). */
function applyGoal(ns: NS, index: number, goal: SleeveGoal): boolean {
  switch (goal.kind) {
    case "karmaCrime":
    case "moneyCrime":
      return ns.sleeve.setToCommitCrime(index, goal.crime as CrimeTypeType);
    case "recovery":
      return ns.sleeve.setToShockRecovery(index);
    case "sync":
      return ns.sleeve.setToSynchronize(index);
    case "faction": {
      const type = workTypeFor(ns, index, goal.faction);
      return !!type && ns.sleeve.setToFactionWork(index, goal.faction as FactionNameType, type as FactionWorkTypeType) === true;
    }
    case "idle":
      ns.sleeve.setToIdle(index);
      return true;
  }
}

function loadMemory(ns: NS): Record<string, SleeveMemory> {
  try {
    return (JSON.parse(ns.read(SLEEVE_STATE_PATH) || "{}") as Record<string, SleeveMemory>) ?? {};
  } catch {
    return {};
  }
}

/** Karma per ms from the player's own crime, if committing one (it keeps going while a sleeve syncs). */
function playerKarmaRate(ns: NS): number {
  const work = ns.singularity.getCurrentWork();
  if (work?.type !== "CRIME") return 0;
  const stats = ns.singularity.getCrimeStats(work.crimeType);
  return (stats.karma * ns.singularity.getCrimeChance(work.crimeType)) / stats.time;
}

/**
 * Whether sleeve `index` should synchronize before committing karma crimes:
 * yes while its sync rate is still unknown (a short probe measures it), then
 * only if syncPaysOff. Needs Formulas.exe for the sleeve's crime chance.
 */
function syncFirst(ns: NS, index: number, sync: number, memory: SleeveMemory, config: SleeveConfig, karma: number): boolean {
  if (sync >= config.minSync) return false;
  if (memory.syncPerMin === undefined) return true;
  if (!ns.fileExists("Formulas.exe", "home")) return false;
  const crime = crimeFor(ns, index, "karma");
  const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
  const sleeveRateAtFull = (stats.karma * ns.formulas.work.crimeSuccessChance(ns.sleeve.getSleeve(index), crime as CrimeTypeType)) / stats.time;
  return syncPaysOff(karma - GANG_KARMA_REQUIREMENT, playerKarmaRate(ns), sleeveRateAtFull, sync, memory.syncPerMin);
}

async function tick(ns: NS, log: Logger, config: SleeveConfig): Promise<void> {
  const info = readBitNodeInfo(ns);
  const count = ns.sleeve.getNumSleeves();
  const now = Date.now();
  const memory = loadMemory(ns);
  const sleeves = Array.from({ length: count }, (_, index) => {
    const s = ns.sleeve.getSleeve(index);
    // Measure sync speed from readings a minute or more apart while syncing.
    const mem = (memory[index] ??= {});
    const reading = { sync: s.sync, t: now, syncing: ns.sleeve.getTask(index)?.type === "SYNCHRO" };
    mem.syncPerMin = updateSyncRate(mem.last, reading, mem.syncPerMin);
    if (!mem.last || now - mem.last.t >= 60_000 || mem.last.syncing !== reading.syncing) mem.last = reading;
    return { index, shock: s.shock, sync: s.sync };
  });
  ns.write(SLEEVE_STATE_PATH, JSON.stringify(memory), "w");

  // Same condition as faction_daemon.ts's karma crime (Approach.GANG).
  const gangAvailable = info?.node === 2 || (info?.sourceFiles["2"] ?? 0) >= 1;
  const karma = ns.getPlayer().karma;
  const chasingKarma = readApproach(ns) === Approach.GANG && gangAvailable && karmaBlocksGang(karma, info?.node);

  const { repGaps, playerFaction } = readRepGaps(ns);
  const goals = decideSleeveGoals(sleeves, {
    karmaCrimeFor: (index) => (chasingKarma ? crimeFor(ns, index, "karma") : undefined),
    syncFirstFor: (index) => chasingKarma && syncFirst(ns, index, sleeves[index].sync, memory[index] ?? {}, config, karma),
    moneyCrimeFor: (index) => crimeFor(ns, index, "money"),
    repGaps,
    playerFaction,
    maxShock: config.maxShock,
    minSync: config.minSync,
  });

  for (const [index, goal] of goals.entries()) {
    if (taskMatchesGoal(ns.sleeve.getTask(index), goal)) continue;
    if (applyGoal(ns, index, goal)) {
      await log.info(`[Sleeve] Sleeve ${index}: ${describeGoal(goal)}.`);
    } else if (goal.kind === "faction") {
      // The game refused the faction (e.g. the player just started working
      // there): earn money instead until next tick.
      const fallback: SleeveGoal = { kind: "moneyCrime", crime: crimeFor(ns, index, "money") };
      if (!taskMatchesGoal(ns.sleeve.getTask(index), fallback) && applyGoal(ns, index, fallback)) goals[index] = fallback;
    }
  }

  const status: SleevesFile = {
    sleeves: sleeves.map((s, i) => ({ ...s, goal: describeGoal(goals[i]), syncPerMin: memory[i]?.syncPerMin })),
    writtenAt: Date.now(),
  };
  ns.write(SLEEVES_PATH, JSON.stringify(status), "w");
  await log.debug(`[Sleeve] tick: ${count} sleeve(s) - ${status.sleeves.map((s) => `${s.index}:${s.goal}`).join(", ")}`);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Sleeve", LOG_LEVEL.DEBUG);

  const info = readBitNodeInfo(ns);
  if (!sleevesAvailable(info?.node, info?.sourceFiles)) {
    await log.info("[Sleeve] No sleeves in this BitNode (needs BitNode 10 or Source-File 10); exiting.");
    return;
  }
  await log.info(`=== Sleeve manager online (${ns.sleeve.getNumSleeves()} sleeve(s)) ===`);

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
    if (config.enabled) await tick(ns, log, config);
    await ns.asleep(TICK_INTERVAL_MS);
  }
}
