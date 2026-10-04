import { NS } from "@ns";
import { effectiveReserve, readSavings } from "system/savings";
import { readPhasePolicy } from "system/phase";
import { bitNodeGrants, readBitNodeInfo } from "system/bitnode_info";
import { loadJsonConfig } from "system/config";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import { CombatStat, FACTION_REPS_PATH, FactionRepsFile, gangTrainingStat, SLEEVE_SAVINGS_REASON } from "factions/faction_decisions";
import { effectiveSkillMult, skillMultiplier } from "factions/skill_progress";
import { averageRatePerMin, readSeries } from "system/monitoring/timeseries";
import {
  CONFIG_PATH as STUDY_CONFIG_PATH,
  DEFAULT_CONFIG as STUDY_DEFAULT_CONFIG,
  freeClass,
  GYM_CITY,
  StudyConfig,
  UNIVERSITY_CITY,
} from "factions/study_decisions";
import { GANG_KARMA_REQUIREMENT, karmaBlocksGang } from "gang/gang_decisions";
import {
  bestCrimeBy,
  CONFIG_PATH,
  COVENANT,
  decideSleeveGoals,
  decideSleeveInvestment,
  DEFAULT_CONFIG,
  describeGoal,
  pickSleeveAug,
  SLEEVE_SHOP_PATH,
  SLEEVE_STATE_PATH,
  SleeveConfig,
  SleeveGoal,
  SleeveMemory,
  SLEEVES_PATH,
  sleevesAvailable,
  SleevesFile,
  SleeveShopFile,
  sleeveTrainingPaysOff,
  syncPaysOff,
  taskMatchesGoal,
  updateSyncRate,
} from "sleeves/sleeve_decisions";

type CrimeTypeType = Parameters<NS["sleeve"]["setToCommitCrime"]>[1];
type GymLocationNameType = Parameters<NS["sleeve"]["setToGymWorkout"]>[1];
type GymTypeType = Parameters<NS["sleeve"]["setToGymWorkout"]>[2];
type CityNameType = Parameters<NS["sleeve"]["travel"]>[1];
type CompanyNameType = Parameters<NS["sleeve"]["setToCompanyWork"]>[1];
type UniversityNameType = Parameters<NS["sleeve"]["setToUniversityCourse"]>[1];
type UniversityClassType = Parameters<NS["sleeve"]["setToUniversityCourse"]>[2];
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

const TICK_INTERVAL_MS = 10_000;
// faction_daemon.ts writes every 5s; allow a few missed writes.
const REPS_MAX_AGE_MS = 60_000;
// Used without Formulas.exe, when crimes can't be ranked per sleeve.
const FALLBACK_CRIME = "Mug";

function readRepGaps(ns: NS): { repGaps: Record<string, number>; playerFaction?: string; companies?: string[] } {
  const raw = ns.read(FACTION_REPS_PATH);
  if (!raw) return { repGaps: {} };
  try {
    const file = JSON.parse(raw) as FactionRepsFile;
    if (Date.now() - file.writtenAt > REPS_MAX_AGE_MS) return { repGaps: {} };
    const repGaps: Record<string, number> = {};
    for (const [faction, target] of Object.entries(file.repTargets ?? {})) repGaps[faction] = target - (file.reps[faction] ?? 0);
    return { repGaps, playerFaction: file.workTarget, companies: (file.companyTargets ?? []).map((c) => c.company) };
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
    case "company":
      return ns.sleeve.setToCompanyWork(index, goal.company as CompanyNameType);
    case "study": {
      const city = UNIVERSITY_CITY[goal.university];
      if (city && ns.sleeve.getSleeve(index).city !== city && !ns.sleeve.travel(index, city as CityNameType)) return false;
      return ns.sleeve.setToUniversityCourse(index, goal.university as UniversityNameType, goal.course as UniversityClassType);
    }
    case "gym": {
      const city = GYM_CITY[goal.gym];
      if (city && ns.sleeve.getSleeve(index).city !== city && !ns.sleeve.travel(index, city as CityNameType)) return false;
      return ns.sleeve.setToGymWorkout(index, goal.gym as GymLocationNameType, goal.stat as GymTypeType);
    }
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
// Gym sleeves train at; levels probed per stint (as faction_daemon.ts's TRAINING_PROBE_LEVELS).
const SLEEVE_GYM = "Powerhouse Gym";
const SLEEVE_TRAINING_PROBE_LEVELS = 10;
const CYCLES_PER_MIN = 300;

/**
 * The karma still to go and today's rate (player and sleeves, from
 * monitoring's karma gauge over 10 minutes, else the player's crime alone).
 */
function karmaProgress(ns: NS, karma: number): { remaining: number; perMs: number } {
  const series = readSeries(ns, "gauge/karma");
  const perMin = series ? -(averageRatePerMin(series, Math.floor(Date.now() / 1000), 600) ?? 0) : 0;
  return { remaining: karma - GANG_KARMA_REQUIREMENT, perMs: perMin > 0 ? perMin / 60_000 : playerKarmaRate(ns) };
}

/**
 * A gym stint for sleeve `index` before its karma crime, when it pays off
 * over the karma still to go (sleeveTrainingPaysOff): the combat stat whose
 * +10 levels raise the crime's chance most (gangTrainingStat), its gym exp
 * scaled by the sleeve's sync. Needs Formulas.exe.
 */
function karmaTraining(ns: NS, index: number, crime: string, progress: { remaining: number; perMs: number }): { stat: string; gym: string } | undefined {
  if (!ns.fileExists("Formulas.exe", "home")) return undefined;
  const person = ns.sleeve.getSleeve(index);
  const chance = (skills: typeof person.skills): number => ns.formulas.work.crimeSuccessChance({ ...person, skills }, crime as CrimeTypeType);
  const chanceNow = chance(person.skills);
  const boost = (stat: CombatStat): number => chance({ ...person.skills, [stat]: person.skills[stat] + SLEEVE_TRAINING_PROBE_LEVELS });
  const stat = gangTrainingStat(chanceNow, 1, person.skills, boost);
  if (!stat) return undefined;

  const gymType = ns.enums.GymType[stat];
  const expKey = `${gymType}Exp` as "strExp" | "defExp" | "dexExp" | "agiExp";
  const expPerMin = ns.formulas.work.gymGains(person, gymType, SLEEVE_GYM as GymLocationNameType)[expKey] * CYCLES_PER_MIN * (person.sync / 100);
  const { mult } = skillMultiplier(stat, person.mults[stat], readBitNodeInfo(ns)?.multipliers, () =>
    effectiveSkillMult(person.skills[stat], (m) => ns.formulas.skills.calculateSkill(person.exp[stat], m))
  );
  if (mult === undefined || !(expPerMin > 0)) return undefined;
  const expNeeded = ns.formulas.skills.calculateExp(person.skills[stat] + SLEEVE_TRAINING_PROBE_LEVELS, mult) - person.exp[stat];
  const trainMs = (Math.max(0, expNeeded) / expPerMin) * 60_000;
  const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
  // Horizon as if every sleeve were on the crime: measured while they train,
  // the rate is the player's alone, which made training always look worth it.
  const sleevesRate = ns.sleeve.getNumSleeves() * ((stats.karma * chanceNow) / stats.time);
  const horizonMs = progress.remaining / (progress.perMs + sleevesRate);
  return sleeveTrainingPaysOff(horizonMs, stats.karma, stats.time, chanceNow, boost(stat), trainMs) ? { stat: gymType, gym: SLEEVE_GYM } : undefined;
}

// Paid classes and the gym cost money per second; below this cash, sleeves
// with nothing else to do take the free class instead (freeClass).
const SLEEVE_TRAINING_MIN_CASH = 100e6;

/** The combat stat a wanted invite is training for (the faction daemon's inviteAction "...: gymWorkout <stat>"), if any. */
function readInviteGymStat(ns: NS): string | undefined {
  const raw = ns.read(FACTION_REPS_PATH);
  if (!raw) return undefined;
  try {
    const file = JSON.parse(raw) as FactionRepsFile;
    if (Date.now() - file.writtenAt > REPS_MAX_AGE_MS) return undefined;
    return /gymWorkout (\w+)/.exec(file.inviteAction ?? "")?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Training for a sleeve with no rep target left, for the player's share of
 * its exp: the gym on a wanted invite's combat stat, else the study
 * config's class (Algorithms at ZB by default, for hacking). While cash
 * can't comfortably pay for those, the free class (freeClass: Computer
 * Science, here or a fare away); undefined - a money crime - only when
 * even that's out of reach. Sleeves used to Mug right after every install.
 */
function playerTraining(ns: NS, inviteStat: string | undefined, index: number): SleeveGoal | undefined {
  const study = loadJsonConfig<StudyConfig>(ns, STUDY_CONFIG_PATH, STUDY_DEFAULT_CONFIG);
  const money = ns.getServerMoneyAvailable("home");
  if (money < SLEEVE_TRAINING_MIN_CASH) {
    const free = freeClass(ns.sleeve.getSleeve(index).city, study.university, money);
    return free ? { kind: "study", course: free.detail, university: free.location } : undefined;
  }
  if (inviteStat && inviteStat in ns.enums.GymType) {
    return { kind: "gym", stat: ns.enums.GymType[inviteStat as keyof typeof ns.enums.GymType], gym: SLEEVE_GYM, purpose: "invite" };
  }
  return { kind: "study", course: study.course, university: study.university };
}

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

const SHOP_SCRIPT = "sleeves/sleeve_shop.js";
const SHOP_INTERVAL_MS = 60_000;
let lastShopRun = 0;

/** sleeve_shop.ts's last report (SLEEVE_SHOP_PATH), any age. */
function readShopFile(ns: NS): SleeveShopFile | undefined {
  try {
    return (JSON.parse(ns.read(SLEEVE_SHOP_PATH) || "null") as SleeveShopFile | null) ?? undefined;
  } catch {
    return undefined;
  }
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

  // Same condition as faction_daemon.ts's karma crime.
  const gangAvailable = bitNodeGrants(info, 2);
  const player = ns.getPlayer();
  const karma = player.karma;
  const chasingKarma = readPhasePolicy(ns).chaseGangKarma && gangAvailable && karmaBlocksGang(karma, info?.node);

  // Only factions the player is in now: right after an install the faction
  // daemon's last file (under a minute old) still lists factions the
  // install left, and setToFactionWork throws for those.
  const progress = chasingKarma ? karmaProgress(ns, karma) : undefined;
  const inviteStat = readInviteGymStat(ns);
  const { repGaps: allGaps, playerFaction, companies } = readRepGaps(ns);
  const repGaps = Object.fromEntries(Object.entries(allGaps).filter(([faction]) => (player.factions as string[]).includes(faction)));
  const goals = decideSleeveGoals(sleeves, {
    karmaCrimeFor: (index) => (chasingKarma ? crimeFor(ns, index, "karma") : undefined),
    syncFirstFor: (index) => chasingKarma && syncFirst(ns, index, sleeves[index].sync, memory[index] ?? {}, config, karma),
    karmaTrainingFor: (index) => (progress ? karmaTraining(ns, index, crimeFor(ns, index, "karma"), progress) : undefined),
    trainingFor: (index) => playerTraining(ns, inviteStat, index),
    moneyCrimeFor: (index) => crimeFor(ns, index, "money"),
    repGaps,
    playerFaction,
    // Only companies the player works for: a sleeve's company work uses the player's position there.
    companies: (companies ?? []).filter((c) => (player.jobs as Partial<Record<string, string>>)[c] !== undefined),
    maxShock: config.maxShock,
    minSync: config.minSync,
  });

  for (const [index, goal] of goals.entries()) {
    if (taskMatchesGoal(ns.sleeve.getTask(index), goal)) continue;
    let applied = false;
    try {
      applied = applyGoal(ns, index, goal);
    } catch (error) {
      await log.warn(`[Sleeve] Sleeve ${index}: couldn't start ${describeGoal(goal)}: ${String(error).split("\n")[0]}`);
    }
    if (applied) {
      await log.info(`[Sleeve] Sleeve ${index}: ${describeGoal(goal)}.`);
    } else if (goal.kind === "faction") {
      // The game refused the faction (e.g. the player just started working
      // there): earn money instead until next tick.
      const fallback: SleeveGoal = { kind: "moneyCrime", crime: crimeFor(ns, index, "money") };
      if (!taskMatchesGoal(ns.sleeve.getTask(index), fallback) && applyGoal(ns, index, fallback)) goals[index] = fallback;
    }
  }

  // Buying (sleeves, memory, augmentations) is a separate one-shot - its
  // API calls cost ~30 GB, too much to keep resident (sleeve_shop.ts).
  if (Date.now() - lastShopRun >= SHOP_INTERVAL_MS && !ns.isRunning(SHOP_SCRIPT, "home") && ns.run(SHOP_SCRIPT) !== 0) lastShopRun = Date.now();
  const shopFile = readShopFile(ns);
  const shop = shopFile ? { nextSleeveCost: shopFile.nextSleeveCost ?? Infinity, lastMessage: shopFile.lastMessage } : undefined;
  const status: SleevesFile = {
    shop,
    sleeves: sleeves.map((s, i) => ({ ...s, goal: describeGoal(goals[i]), syncPerMin: memory[i]?.syncPerMin, memory: ns.sleeve.getSleeve(i).memory, augs: shopFile?.augs?.[i] })),
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
