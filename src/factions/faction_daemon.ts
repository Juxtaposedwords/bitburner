import { NS } from "@ns";
import { readFreshJson } from "system/fresh_file";
import { COVENANT, SLEEVES_PATH, SleevesFile } from "sleeves/sleeve_decisions";
import { loadJsonConfig } from "system/config";
import { bitNodeGrants, readBitNodeInfo } from "system/bitnode_info";
import {
  advanceSpendDown,
  clearInstallPending,
  readInstallPending,
  spendDownSettled,
  touchInstallPending,
  writeInstallPending,
} from "system/install_handshake";
import { writeSavings } from "system/savings";
import { incomePerMin } from "system/monitoring/timeseries";
import { addRepSample, installNowEstimate, measuredRepPerMin, RepSample } from "factions/training_plan";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import {
  AugmentationInfo,
  bestWorkType,
  catalogsFor,
  CITY_FACTION_NAMES,
  focusPriceLimit,
  focusStatsFor,
  describeUnmetRequirements,
  combatBlocksInvite,
  companyRepRequirement,
  companyTargets,
  CompanyTarget,
  RED_PILL,
  SLEEVE_SAVINGS_REASON,
  sleeveSavings,
  grindInstallPays,
  pickInstallEnabler,
  FavorPlanEntry,
  GrindStatus,
  grindAllowsInstall,
  WORK_SLOT_PATH,
  WorkSlotFile,
  workSlotFree,
  INSTALL_LOOP_PATH,
  InstallLoopFile,
  installLoopActive,
  NEUROFLUX_GOVERNOR,
  CombatStat,
  COMPANY_FACTION_EMPLOYER,
  COMPANY_FACTION_NAMES,
  CRIMINAL_FACTION_NAMES,
  decideAugmentationPurchase,
  decideCrimeForKills,
  decideDonation,
  DonationDecision,
  FACTION_REPS_PATH,
  FactionRepsFile,
  decideEligibilityStandDown,
  decideFactionsToJoin,
  decideInstallReady,
  decidePreInstall,
  decideWorkTarget,
  EligibilityAction,
  EligibilitySnapshot,
  findBlockingRequirement,
  hasAnyCityFaction,
  favorPlan,
  donationTarget,
  readyToFinish,
  DAEDALUS,
  INSTALL_HISTORY_PATH,
  favorPlanReady,
  gangTrainingStat,
  pendingAugmentations,
  pickKarmaCrime,
  trainingPaysOff,
  priorityFocus,
  PurchaseDecision,
  redPillFocus,
  onlyCombatLeft,
  repTargets,
  requirementToAction,
  unmetMoneyRequirement,
  usefulCatalog,
  workableFactions,
  wantedInviteFactions,
} from "factions/faction_decisions";
import * as player_metadata_pb from "system/rpc/player_metadata";
import { GANG_KARMA_REQUIREMENT, karmaBlocksGang } from "gang/gang_decisions";
import { canAffordTraining, GYM_CITY, trainingCostPerMin } from "factions/study_decisions";
import { appendJsonLine } from "system/history";
import { Approach } from "system/rpc/scheduler";
import { derivePhase, parseApproachOverride, PHASE_PATH, PhaseFile, phasePolicy, requiredHackingMult, SCHEDULER_CONFIG_PATH } from "system/phase";
import {
  combineMultipliers,
  compareInstall,
  effectiveSkillMult,
  skillMultiplier,
  hackingGoal,
  matchesFocus,
  PENDING_BOOST_PATH,
  PendingBoost,
} from "factions/skill_progress";
import * as server_metadata_pb from "system/rpc/server_metadata";

// FactionName/FactionWorkType/CompanyName/CityName/JobField/CrimeType/
// GymLocationName are big string-literal unions not exported by name
// from "@ns" - pulled out structurally the same way hacknet_daemon.ts
// derives HashUpgradeName, rather than duplicating the literal list
// here. Our own decision logic treats all of these as plain strings
// throughout (see faction_decisions.ts) since it has no `ns` dependency;
// these casts are only needed at the boundary where a plain string
// crosses back into an ns.singularity.* call.
type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];
type FactionWorkTypeType = Parameters<NS["singularity"]["workForFaction"]>[1];
type CityNameType = Parameters<NS["singularity"]["travelToCity"]>[0];
type CompanyNameType = Parameters<NS["singularity"]["applyToCompany"]>[0];
type JobFieldType = Parameters<NS["singularity"]["applyToCompany"]>[1];
type CrimeTypeType = Parameters<NS["singularity"]["commitCrime"]>[0];
type GymLocationNameType = Parameters<NS["singularity"]["gymWorkout"]>[0];
type GymTypeType = Parameters<NS["singularity"]["gymWorkout"]>[1];

const WORLD_DAEMON = "w0r1d_d43m0n";
const FINISH_TOOL = "tools/finish_bitnode.js";
// finish_bitnode.js launched this run (it ends the BitNode, and this script with it).
let finishLaunched = false;
// ns.formulas.work.*Gains are per 200ms game cycle.
const CYCLES_PER_MIN = 300;
// Every install, newest INSTALL_HISTORY_CAP (archived locally by the bridge).
const INSTALL_HISTORY_CAP = 200;

// Install once cash hasn't dropped for this long during the spend-down -
// several gang_daemon.ts ticks (5s) with nothing left to buy.
const SPEND_DOWN_SETTLE_MS = 20_000;
// Same affordability rule as study_daemon.ts's paid training.
const GYM_RUNWAY_MINUTES = 10;
const GYM_FALLBACK_MIN_CASH = 1e9;

/**
 * The third file allowed to import ns.singularity (after
 * hacking/program_shopper.ts and backdoor_daemon.ts) - kept isolated for the
 * same RAM-cost reason (see server_metadata.md). Only launched by boot.ts
 * when PlayerMetadata.singularityAvailable is true. (A fourth,
 * tools/augmentation_report.ts, reuses this file's own gather/decide
 * exports rather than re-deriving anything - see its module doc.)
 *
 * No RPC service of its own. Faction reputation/augmentation state is
 * cheap to re-derive fresh from ns.singularity.* every tick, and so is
 * membership itself - ns.getPlayer().factions is the live, current list
 * (an earlier version of this file mistakenly persisted its own
 * /var/faction_state.txt copy instead, reasoning that
 * checkFactionInvitations() stops listing a faction once you're a member
 * so membership "can't be re-derived live" - true of that one function,
 * but ns.getPlayer().factions gives it directly. That persisted copy
 * went stale across an installAugmentations reset, which clears
 * Player.factions entirely (confirmed against Bitburner's own
 * PlayerObjectGeneralMethods.ts) but doesn't touch a file already
 * sitting on home - the daemon kept believing it was still joined to
 * factions it had actually lost, forever blocking re-invitation. Reading
 * ns.getPlayer().factions directly every tick has no such staleness
 * window, and as a bonus also correctly picks up any faction joined
 * outside this daemon entirely (e.g. manually, to found a gang) instead
 * of never learning about it.
 *
 * There IS now a small /var/faction_state.txt (same path as the retired
 * membership copy above, but an unrelated concern - see FactionState
 * below): it exists purely to bound crime-for-kills grinding, not to
 * cache anything re-derivable.
 *
 * Active eligibility (pursueCityFactions/pursueCompanyFactions/
 * pursueCriminalFactions below): everything above only ever reacts to
 * checkFactionInvitations() - it never does anything to become eligible
 * for a faction we're not yet invited to. See faction_decisions.ts's own
 * module doc for the getFactionInviteRequirements-driven engine this is
 * built on, and server_metadata.md for the full design writeup (work-slot
 * priority policy, city mutual-exclusivity policy, scope cuts).
 */
export type FactionConfig = {
  enabled: boolean;
  reserveMoney: number;
  maxSpendFraction: number;
  // undefined = accept every faction invitation; set to restrict which
  // factions get auto-joined.
  joinAllowlist?: string[];
  // Both start false: buying spends real money, and installing wipes
  // every running script (a full reboot into bootScript) - opt in
  // explicitly once the join+work loop has been watched running safely.
  autoPurchaseAugmentations: boolean;
  autoInstall: boolean;
  // Buy an augmentation's missing reputation with money at factions that
  // accept donations (see decideDonation). Only acts when
  // autoPurchaseAugmentations is also on - a donation only ever happens to
  // make an augmentation buyable. Needs Formulas.exe for the exact amount.
  autoDonate: boolean;
  // Share of cash one donation (plus the augmentation's price) may use.
  // Separate from maxSpendFraction, which throttles the many small repeated
  // purchases across daemons: a donation is one targeted lump with a known
  // payoff, and at 0.5 a ~$61B NeuroFlux unlock waited for ~$122B cash.
  donationSpendFraction: number;
  // Script to relaunch into after installAugmentations wipes everything.
  bootScript: string;

  // City factions - mutually exclusive within a BitNode run (see
  // hasAnyCityFaction's doc). Off by default: travel itself is cheap and
  // reversible, but this is new behavior worth watching run once before
  // trusting, same posture as autoPurchaseAugmentations/autoInstall.
  pursueCityFactions: boolean;
  // Walked in order; the category stops entirely once ANY of these is
  // joined - editable if a specific city is preferred.
  cityFactionPriority: string[];

  pursueCompanyFactions: boolean;
  companyPriority: string[];
  // JobField passed to applyToCompany - a single config string, not
  // ROI-optimized by salary/rep-gain-rate (deliberate v1 simplification,
  // same tradeoff gang_decisions.ts's decideEquipmentPurchase already
  // accepts for gang equipment).
  companyJobField: string;

  pursueCriminalFactions: boolean;
  criminalFactionPriority: string[];
  // Off by default even under pursueCriminalFactions=true: committing
  // crimes to farm numPeopleKilled is the one genuinely irreversible,
  // game-telegraphed-as-serious action in this whole feature - opt in
  // explicitly. Every other criminal-faction gap (combat stats via
  // gymWorkout) is safe/reversible and needs no separate flag.
  enableCrimeForKills: boolean;
  minCrimeSuccessChance: number;
  // Circuit breaker via /var/faction_state.txt's crimeAttempts - mirrors
  // gang_decisions.ts's decideStandDown/maxCasualties exactly.
  maxCrimeAttempts: number;
  // Any gym in study_decisions.ts's GYM_CITY - the daemon travels to its
  // city before a workout.
  gymLocation: string;

  // Factions whose invite is worth working for (gym time for combat
  // requirements, via pursueWantedInvites) while they sell an augmentation
  // not owned yet - even ahead of faction work. Invites are lost at every
  // install, and these end-game factions sell the big augmentations.
  pursueAugmentationFactions: string[];
  // Without Formulas.exe, Approach.GANG trains combat at the gym while the
  // karma crime's success chance is below this; with it, trainingPaysOff
  // decides instead (see decideGangTraining).
  gangCrimeMinChance: number;

  // What makes an augmentation "good" (multiplier keys from
  // getAugmentationStats). In Approach.GROW_STATS and Approach.AUGMENTS only
  // augmentations raising one of these are bought or donated for, and in
  // AUGMENTS the most expensive reachable one is saved for and bought first
  // (priorityFocus). Hacking level/experience by default: the level
  // multiplier sits inside an exponent (see skill_progress.ts), so it's worth
  // far more toward w0r1d_d43m0n than anything else. [] = buy everything.
  augmentationFocus: string[];
  // What makes an augmentation worth rep or money at all, in every mode
  // (multiplier keys; [] = everything; The Red Pill always counts). See
  // usefulCatalog - BN10 spent rep and 5x-price money on five Hacknet
  // augmentations that did nothing for the run.
  usefulAugmentationStats: string[];
  // Also worth buying, after augmentationFocus: in AUGMENTS, once no focus
  // augmentation is left reachable, these (with usefulAugmentationStats)
  // take over (focusStatsFor). Combat by default - Daedalus (The Red Pill)
  // takes 1500 in every combat stat instead of 2500 hacking, and The
  // Covenant/Illuminati have combat routes too. BN10's loop owned every
  // hacking augmentation Slum Snakes sells and then bought nothing, with
  // $18T and 25M rep there.
  secondaryAugmentationStats: string[];
  // Hacking level GROW_STATS works toward; 0 = w0r1d_d43m0n's requirement
  // once visible, else Daedalus's 2500 (see hackingGoal).
  growStatsHackingGoal: number;
  // During GROW_STATS, install only if it reaches the goal in at most this
  // fraction of the time staying would take (compareInstall's ratio). Below
  // 1 because an install also resets the Hacknet and its study upgrades,
  // which the comparison doesn't count.
  growStatsInstallMaxRatio: number;
  // Short, because a reinstall is cheap: the gang keeps earning and its
  // faction's rep was back to 25M three minutes after one in BN10, while
  // at 30 the loop kept waiting on 1.9^12-inflated prices.
  // In AUGMENTS, only augmentations within this many minutes of income are
  // saved for, dearest first (focusPriceLimit). Once none are left, what's
  // affordable gets bought and, with autoInstall, the install resets the
  // 1.9x price inflation for the next cycle. 0 = no limit.
  maxFocusWaitMinutes: number;
  // FACTION_GRIND's estimate of what an install costs in grind time: the
  // reboot plus hacking level regrowing from batches (BN10: 737 three
  // minutes after an install). An install goes ahead when the favor it
  // banks speeds up the rest by more than this (grindInstallPays).
  grindInstallOverheadMinutes: number;
  // BitNode 10: save for the next Covenant sleeve once it's within this
  // many minutes of income (sleeveSavings). 0 = never save for sleeves.
  sleeveSaveMinutes: number;
  // Work toward corporate factions selling useful augmentations not owned
  // yet: hold a job at each employer (applying again each tick also takes
  // promotions) and publish company rep progress, which sleeves work on
  // and the hacknet buys Company Favor for (companyTargets).
  pursueCompanyTargets: boolean;
  // Work, save and buy toward The Red Pill (which leads to finishing the
  // BitNode). Off while staying in a BitNode on purpose.
  pursueRedPill: boolean;
  // The finish line (with pursueRedPill): Daedalus's hacking requirement,
  // and the hacking exp one long stint can be expected to reach - the
  // DAEDALUS phase starts once the multiplier gets there with it
  // (system/phase.ts's requiredHackingMult).
  finishHackingLevel: number;
  finishExpBudget: number;
  // The BitNode to start once this one can be finished (readyToFinish):
  // tools/finish_bitnode.js runs on its own. 0 leaves it to a person
  // (tools/status.js flags it) - finishing can't be undone, and a BitNode
  // kept on purpose (BN10 for Covenant sleeves) mustn't end by accident.
  nextBitNode: number;
};

// Window the AUGMENTS focus wait limit measures income over.
const INCOME_WINDOW_SEC = 10 * 60;

export const DEFAULT_CONFIG: FactionConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  autoPurchaseAugmentations: false,
  autoInstall: false,
  maxFocusWaitMinutes: 5,
  grindInstallOverheadMinutes: 10,
  sleeveSaveMinutes: 480,
  pursueCompanyTargets: true,
  pursueRedPill: true,
  finishHackingLevel: 2500,
  // BN12: one 80-minute stint reached 1.2e10 at 3.25e8/min and rising, so
  // ~6 hours reaches ~3e11 (3e10 asked for a 4.37 multiplier, not 3.88).
  finishExpBudget: 3e11,
  nextBitNode: 0,
  autoDonate: true,
  donationSpendFraction: 0.9,
  bootScript: "boot.js",

  pursueCityFactions: false,
  cityFactionPriority: [...CITY_FACTION_NAMES],

  pursueCompanyFactions: false,
  companyPriority: [...COMPANY_FACTION_NAMES],
  companyJobField: "Business",

  pursueCriminalFactions: false,
  criminalFactionPriority: [...CRIMINAL_FACTION_NAMES],
  enableCrimeForKills: false,
  minCrimeSuccessChance: 0.5,
  maxCrimeAttempts: 100,
  // The highest-experience gym (see skill_eta.js's gym comparison).
  gymLocation: "Powerhouse Gym",
  pursueAugmentationFactions: ["Illuminati", "The Covenant", "Daedalus"],
  gangCrimeMinChance: 0.8,

  augmentationFocus: ["hacking", "hacking_exp"],
  // Hacking level/experience and hacking income, plus faster faction rep.
  usefulAugmentationStats: ["hacking", "hacking_exp", "hacking_chance", "hacking_speed", "hacking_money", "hacking_grow", "faction_rep"],
  secondaryAugmentationStats: ["strength", "defense", "dexterity", "agility", "strength_exp", "defense_exp", "dexterity_exp", "agility_exp"],
  growStatsHackingGoal: 0,
  growStatsInstallMaxRatio: 0.8,
};

export const CONFIG_PATH = "/etc/faction.txt";
const STATE_PATH = "/var/faction_state.txt";
const TICK_INTERVAL_MS = 5000;

/** Daemon-owned runtime state, separate from user policy config - same /etc vs /var split as gang_daemon.ts's GangConfig/GangState. Bounds crime-for-kills grinding only; unrelated to the retired membership-persistence concern documented above. */
export type FactionState = { crimeAttempts: number };
const DEFAULT_STATE: FactionState = { crimeAttempts: 0 };

export function loadState(ns: NS): FactionState {
  return loadJsonConfig(ns, STATE_PATH, DEFAULT_STATE);
}

function saveState(ns: NS, state: FactionState): void {
  ns.write(STATE_PATH, JSON.stringify(state, null, 2), "w");
}

/** Every augmentation offered by any joined faction, queried live - no persisted catalog. */
export function gatherCatalog(ns: NS, joinedFactions: string[]): AugmentationInfo[] {
  const catalog: AugmentationInfo[] = [];
  for (const faction of joinedFactions) {
    for (const name of ns.singularity.getAugmentationsFromFaction(faction as FactionNameType)) {
      catalog.push({
        name,
        faction,
        price: ns.singularity.getAugmentationPrice(name),
        repReq: ns.singularity.getAugmentationRepReq(name),
        prereqs: ns.singularity.getAugmentationPrereq(name),
        stats: ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>,
      });
    }
  }
  return catalog;
}

export function gatherReps(ns: NS, joinedFactions: string[]): Record<string, number> {
  const reps: Record<string, number> = {};
  for (const faction of joinedFactions) reps[faction] = ns.singularity.getFactionRep(faction as FactionNameType);
  return reps;
}

/** Augmentations bought but not yet applied via installAugmentations - the owned(true)/owned(false) diff already inlined in tick(), pulled out so augmentation_report.ts shares the same definition. */
export function getPendingAugmentations(ns: NS): string[] {
  return pendingAugmentations(ns.singularity.getOwnedAugmentations(true), ns.singularity.getOwnedAugmentations(false));
}

/**
 * The work type earning the most rep at `faction` right now (bestWorkType),
 * with each offered type's rep/min from ns.formulas.work.factionGains (0 GB,
 * per 200ms cycle). Without Formulas.exe: "hacking" if offered, else the
 * first - see faction_decisions.ts's module doc for why there's no
 * hardcoded faction->workType table.
 */
function pickWorkType(
  ns: NS,
  faction: string,
  player: ReturnType<NS["getPlayer"]>
): { type: string | undefined; gains?: Record<string, number> } {
  const types = ns.singularity.getFactionWorkTypes(faction as FactionNameType);
  if (!ns.fileExists("Formulas.exe", "home")) return { type: types.includes("hacking") ? "hacking" : types[0] };

  const favor = ns.singularity.getFactionFavor(faction as FactionNameType);
  const gains: Record<string, number> = {};
  for (const type of types) gains[type] = ns.formulas.work.factionGains(player, type, favor).reputation * CYCLES_PER_MIN;
  return { type: bestWorkType(types, gains), gains };
}

/**
 * ns.singularity.workForFaction restarts the work action (and snaps the
 * game's UI to the work screen) every time it's called, even for the
 * same faction/type already in progress - calling it unconditionally
 * every 5s tick made the UI jump constantly, with no way to navigate
 * elsewhere. Checked via getCurrentWork rather than tracking our own
 * "last assigned" state, so it stays correct even if the player manually
 * starts different work in between ticks.
 */
function isAlreadyWorking(ns: NS, faction: string, workType: string): boolean {
  const current = ns.singularity.getCurrentWork();
  return current?.type === "FACTION" && current.factionName === faction && current.factionWorkType === workType;
}

/** Builds an EligibilitySnapshot from a single ns.getPlayer() call - companyReps starts empty, filled in per-candidate by pursueCompanyFactions. */
function gatherEligibilitySnapshot(player: ReturnType<NS["getPlayer"]>): EligibilitySnapshot {
  return {
    money: player.money,
    skills: {
      hacking: player.skills.hacking,
      strength: player.skills.strength,
      defense: player.skills.defense,
      dexterity: player.skills.dexterity,
      agility: player.skills.agility,
      charisma: player.skills.charisma,
      intelligence: player.skills.intelligence,
    },
    karma: player.karma,
    numPeopleKilled: player.numPeopleKilled,
    city: player.city,
    jobs: player.jobs,
    companyReps: {},
  };
}

/**
 * Only ever produces a `travel` action - city faction invites gate on
 * `city` + `money`, and money isn't something this feature can act on.
 * Stops the whole category dead once ANY city faction is joined
 * (hasAnyCityFaction): city factions are mutually exclusive within a
 * BitNode run (each lists some of the others as `enemies`, permanently
 * banned on join - confirmed via Bitburner's FactionInfo.tsx), and rather
 * than model that asymmetric graph (a second source of truth that could
 * drift), this just stops - correct regardless of the exact graph, since
 * checkFactionInvitations() will never surface an enemy's invite again
 * once we're in one of its enemies, so continuing to chase one after that
 * point would be pure waste. cityFactionPriority controls which one gets
 * pursued first.
 */
function pursueCityFactions(ns: NS, config: FactionConfig, snapshot: EligibilitySnapshot, joinedFactions: string[]): EligibilityAction {
  if (hasAnyCityFaction(joinedFactions)) return { kind: "none" };

  for (const faction of config.cityFactionPriority) {
    if (joinedFactions.includes(faction)) continue;
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    const blocking = findBlockingRequirement(requirements, snapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, snapshot);
    if (action.kind !== "none") return action;
  }
  return { kind: "none" };
}

/**
 * No short-circuit - company factions stack normally, unlike city
 * factions. companyReps is populated live per-candidate (only for
 * whichever employer is actually being evaluated this iteration, not
 * eagerly for all ten) since getCompanyRep needs a real employer name and
 * Fulcrum Secret Technologies' employer (Fulcrum Technologies) differs
 * from its faction name - the one mismatch, resolved via
 * COMPANY_FACTION_EMPLOYER.
 */
function pursueCompanyFactions(ns: NS, config: FactionConfig, snapshot: EligibilitySnapshot, joinedFactions: string[]): EligibilityAction {
  for (const faction of config.companyPriority) {
    if (joinedFactions.includes(faction)) continue;
    const employer = COMPANY_FACTION_EMPLOYER[faction] ?? faction;
    const candidateSnapshot: EligibilitySnapshot = {
      ...snapshot,
      companyReps: { ...snapshot.companyReps, [employer]: ns.singularity.getCompanyRep(employer as CompanyNameType) },
    };
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    const blocking = findBlockingRequirement(requirements, candidateSnapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, candidateSnapshot);
    if (action.kind !== "none") return action;
  }
  return { kind: "none" };
}

/** Data-driven crime selection (see decideCrimeForKills's doc) over every live CrimeType - never a hardcoded "Homicide" string. */
// How far each stat is raised when comparing which one helps a crime most.
const TRAINING_PROBE_LEVELS = 10;

/**
 * `crime`'s success chance with one combat stat raised by
 * TRAINING_PROBE_LEVELS, by formula (ns.formulas.work.crimeSuccessChance,
 * 0 GB) - for gangTrainingStat's choice. undefined without Formulas.exe.
 */
function crimeChanceWithBoost(ns: NS, player: ReturnType<NS["getPlayer"]>, crime: string): ((stat: CombatStat) => number) | undefined {
  if (!ns.fileExists("Formulas.exe", "home")) return undefined;
  return (stat) => {
    const person = { ...player, skills: { ...player.skills, [stat]: player.skills[stat] + TRAINING_PROBE_LEVELS } };
    return ns.formulas.work.crimeSuccessChance(person, crime as CrimeTypeType);
  };
}

/**
 * The combat stat to train instead of committing `crime`, or undefined to
 * commit it. With Formulas.exe: the stat whose small raise helps the chance
 * most (gangTrainingStat), trained only if trainingPaysOff says the gym time
 * is won back. Without it: gangTrainingStat's fixed-threshold fallback.
 */
function decideGangTraining(
  ns: NS,
  config: FactionConfig,
  player: ReturnType<NS["getPlayer"]>,
  crime: string,
  chanceNow: number,
  snapshot: EligibilitySnapshot
): CombatStat | undefined {
  const boost = crimeChanceWithBoost(ns, player, crime);
  if (!boost) return gangTrainingStat(chanceNow, config.gangCrimeMinChance, snapshot.skills);

  const stat = gangTrainingStat(chanceNow, 1, snapshot.skills, boost);
  if (!stat) return undefined;
  const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
  const gymType = ns.enums.GymType[stat];
  const expPerMin =
    ns.formulas.work.gymGains(player, gymType, config.gymLocation as GymLocationNameType)[`${gymType}Exp` as "strExp" | "defExp" | "dexExp" | "agiExp"] *
    CYCLES_PER_MIN;
  const { mult } = skillMultiplier(stat, player.mults[stat], readBitNodeInfo(ns)?.multipliers, () =>
    effectiveSkillMult(player.skills[stat], (m) => ns.formulas.skills.calculateSkill(player.exp[stat], m))
  );
  if (mult === undefined || !(expPerMin > 0)) return undefined;
  const expNeeded = ns.formulas.skills.calculateExp(player.skills[stat] + TRAINING_PROBE_LEVELS, mult) - player.exp[stat];
  const trainMs = (Math.max(0, expNeeded) / expPerMin) * 60_000;
  const remainingKarma = player.karma - GANG_KARMA_REQUIREMENT;
  return trainingPaysOff(remainingKarma, stats.karma, stats.time, chanceNow, boost(stat), trainMs) ? stat : undefined;
}

/** pickKarmaCrime over every live CrimeType's karma, time, and success chance. */
function pickKarmaCrimeLive(ns: NS): string | undefined {
  return pickKarmaCrime(
    Object.values(ns.enums.CrimeType).map((crime) => {
      const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
      return { crime, karma: stats.karma, timeMs: stats.time, successChance: ns.singularity.getCrimeChance(crime as CrimeTypeType) };
    })
  );
}

function pickCrimeForKills(ns: NS, minSuccessChance: number): string | undefined {
  const candidates = Object.values(ns.enums.CrimeType).map((crime) => ({
    crime,
    kills: ns.singularity.getCrimeStats(crime as CrimeTypeType).kills,
    successChance: ns.singularity.getCrimeChance(crime as CrimeTypeType),
  }));
  return decideCrimeForKills(candidates, minSuccessChance);
}

/**
 * Walks criminalFactionPriority once. Safe actions (gymWorkout/quitJob/
 * travel) from ANY candidate faction are returned immediately; a
 * commitCrime need is deferred (only the first one found) so every safe
 * option across the whole category is tried first - risk-ascending, same
 * ordering decideEligibilityWorkSlotAction uses one level up. The
 * deferred crime is only actually returned if enableCrimeForKills is on
 * and the /var/faction_state.txt circuit breaker hasn't tripped; tripping
 * is logged once here (not per-candidate) so it doesn't spam.
 */
async function pursueCriminalFactions(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  state: FactionState,
  snapshot: EligibilitySnapshot,
  joinedFactions: string[]
): Promise<EligibilityAction> {
  let deferredCrime: EligibilityAction | undefined;

  for (const faction of config.criminalFactionPriority) {
    if (joinedFactions.includes(faction)) continue;
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    const blocking = findBlockingRequirement(requirements, snapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, snapshot);
    if (action.kind === "none") continue;

    if (action.kind === "commitCrime") {
      if (!deferredCrime) {
        const crime = pickCrimeForKills(ns, config.minCrimeSuccessChance);
        if (crime) deferredCrime = { kind: "commitCrime", crime };
      }
      continue;
    }
    return action;
  }

  if (!deferredCrime) return { kind: "none" };
  if (!config.enableCrimeForKills) return { kind: "none" };
  if (decideEligibilityStandDown(state.crimeAttempts, config.maxCrimeAttempts)) {
    await log.warn(
      `[Faction] Standing down from crime-for-kills - ${state.crimeAttempts} attempts >= maxCrimeAttempts (${config.maxCrimeAttempts}). ` +
        `Edit ${STATE_PATH}'s crimeAttempts back down (or delete the file) once you're ready to try again.`
    );
    return { kind: "none" };
  }
  return deferredCrime;
}

/**
 * Only called when decideWorkTarget (existing, unchanged) returns
 * undefined - grinding reputation at an already-joined faction toward an
 * unowned augmentation always wins the single work slot. See
 * server_metadata.md for why this doesn't make the feature dead code:
 * with autoPurchaseAugmentations at its default false, reputation keeps
 * accumulating past every augmentation's repReq with nothing spent on
 * it, so decideWorkTarget legitimately returns undefined once every
 * joined faction's augmentations are rep-satisfied - a common steady
 * state, not a rare edge case. Company pursuit is tried before criminal
 * pursuit's own safe-then-risky ordering (see pursueCriminalFactions) -
 * company work is fully reversible via quitJob, so it's the least risky
 * new use of the work slot.
 */
async function decideEligibilityWorkSlotAction(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  state: FactionState,
  snapshot: EligibilitySnapshot,
  joinedFactions: string[]
): Promise<EligibilityAction> {
  if (config.pursueCompanyFactions) {
    const companyAction = pursueCompanyFactions(ns, config, snapshot, joinedFactions);
    if (companyAction.kind !== "none") return companyAction;
  }
  if (config.pursueCriminalFactions) {
    return await pursueCriminalFactions(ns, log, config, state, snapshot, joinedFactions);
  }
  return { kind: "none" };
}

/** Whether cash covers GYM_RUNWAY_MINUTES at `gymLocation` (canAffordTraining), costed by formula when Formulas.exe is owned. */
function gymAffordable(ns: NS, gymType: GymTypeType, gymLocation: string): boolean {
  const costPerMin = ns.fileExists("Formulas.exe", "home")
    ? trainingCostPerMin(ns.formulas.work.gymGains(ns.getPlayer(), gymType, gymLocation as GymLocationNameType).money, CYCLES_PER_MIN)
    : undefined;
  return canAffordTraining(ns.getServerMoneyAvailable("home"), costPerMin, GYM_RUNWAY_MINUTES, GYM_FALLBACK_MIN_CASH);
}

/**
 * Generalizes isAlreadyWorking's discipline (never restart an
 * already-correct work action every tick) across every new action kind
 * that also claims the single work slot - workForCompany/gymWorkout/
 * commitCrime all cancel whatever's currently in progress when called
 * (confirmed in each function's own doc), same as workForFaction. travel
 * and quitJob don't touch the work slot at all, so they're always safe to
 * call, gated only by their own idempotency check (already-in-that-city /
 * always-safe-to-repeat respectively).
 *
 * Returns true if a commitCrime action actually executed (so tick() can
 * increment /var/faction_state.txt's crimeAttempts) - deliberately
 * counted per *call* (i.e. per time we actually told the game to start
 * committing this crime), not per individual crime completion inside
 * that run, since commitCrime (like workForFaction) keeps looping on its
 * own between ticks once started; that's a coarser circuit breaker than
 * literal kill attempts, but matches this codebase's existing
 * "bound how many times we resort to this" intent (see
 * gang_decisions.ts's decideStandDown).
 */
async function executeEligibilityAction(ns: NS, log: Logger, action: EligibilityAction, gymLocation: string): Promise<boolean> {
  const current = ns.singularity.getCurrentWork();

  switch (action.kind) {
    case "none":
      return false;

    case "travel":
      if (ns.getPlayer().city !== action.city && ns.singularity.travelToCity(action.city as CityNameType)) {
        await log.info(`[Faction] Traveled to ${action.city}.`);
      }
      return false;

    case "quitJob":
      ns.singularity.quitJob(action.company as CompanyNameType);
      await log.info(`[Faction] Quit job at ${action.company} to clear a criminal-faction requirement.`);
      return false;

    case "applyToCompany": {
      const job = ns.singularity.applyToCompany(action.company as CompanyNameType, action.field as JobFieldType);
      if (job) await log.info(`[Faction] Applied to ${action.company}, hired as ${job}.`);
      return false;
    }

    case "workForCompany":
      if (!(current?.type === "COMPANY" && current.companyName === action.company)) {
        if (ns.singularity.workForCompany(action.company as CompanyNameType)) {
          await log.info(`[Faction] Working for ${action.company} to build reputation toward its faction invite.`);
        }
      }
      return false;

    case "gymWorkout": {
      const gymType = ns.enums.GymType[action.stat];
      // gymWorkout fails outside the gym's city - the study daemon may have
      // left the player at a university elsewhere.
      const gymCity = GYM_CITY[gymLocation];
      if (gymCity && ns.getPlayer().city !== gymCity && ns.singularity.travelToCity(gymCity as CityNameType)) {
        await log.info(`[Faction] Traveled to ${gymCity} for ${gymLocation}.`);
      }
      // The gym charges per second: only with cash for a runway of it, and
      // stop a workout already running rather than go into debt.
      if (!gymAffordable(ns, gymType, gymLocation)) {
        if (current?.type === "CLASS" && current.location === gymLocation && ns.singularity.stopAction()) {
          await log.warn(`[Faction] Stopped training ${action.stat}: cash doesn't cover ${GYM_RUNWAY_MINUTES} minutes at ${gymLocation}.`);
        }
        return false;
      }
      if (!(current?.type === "CLASS" && current.location === gymLocation && current.classType === gymType)) {
        if (ns.singularity.gymWorkout(gymLocation as GymLocationNameType, gymType)) {
          await log.info(`[Faction] Training ${action.stat} at ${gymLocation}.`);
        }
      }
      return false;
    }

    case "commitCrime":
      if (!(current?.type === "CRIME" && current.crimeType === action.crime)) {
        ns.singularity.commitCrime(action.crime as CrimeTypeType);
        await log.info(`[Faction] Committing ${action.crime}.`);
        return true;
      }
      return false;
  }
}

/**
 * The first action that works toward an invite from a faction in
 * config.pursueAugmentationFactions that still sells something wanted
 * (wantedInviteFactions): the same requirement engine as the criminal
 * factions (findBlockingRequirement/requirementToAction), so e.g. a combat
 * gap becomes gym time. Crime is never chosen here - it has its own opt-in
 * (enableCrimeForKills). Hacking-level gaps are waited out; the largest
 * unmet cash requirement is returned as `moneyNeeded`, which AUGMENTS mode
 * saves for (otherwise NeuroFlux donations kept cash below Illuminati's $150B
 * and the invite never came).
 */
function pursueWantedInvites(
  ns: NS,
  config: FactionConfig,
  snapshot: EligibilitySnapshot,
  joinedFactions: string[],
  owned: string[]
): {
  action?: { faction: string; action: EligibilityAction };
  moneyNeeded?: { faction: string; amount: number };
  blockers: Record<string, string[]>;
} {
  const offered: Record<string, string[]> = {};
  for (const faction of config.pursueAugmentationFactions) {
    // Without pursueRedPill, The Red Pill doesn't make a faction worth an
    // invite (Daedalus sells nothing else but NeuroFlux).
    offered[faction] = ns.singularity
      .getAugmentationsFromFaction(faction as FactionNameType)
      .filter((name) => config.pursueRedPill || name !== RED_PILL);
  }
  const blockers: Record<string, string[]> = {};
  const installedCount = ns.singularity.getOwnedAugmentations(false).length;
  let found: { faction: string; action: EligibilityAction } | undefined;
  let moneyNeeded: { faction: string; amount: number } | undefined;
  // BitNode 10: The Covenant sells sleeves too (sleeve_daemon.ts publishes
  // the next one's cost; Infinity once all 5 are bought).
  const shop = readFreshJson<SleevesFile>(ns, SLEEVES_PATH, 120_000)?.shop;
  const alsoWanted = shop && Number.isFinite(shop.nextSleeveCost) ? [COVENANT] : [];
  for (const faction of wantedInviteFactions(config.pursueAugmentationFactions, joinedFactions, offered, owned, alsoWanted)) {
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    blockers[faction] = describeUnmetRequirements(requirements, snapshot, installedCount);
    const money = unmetMoneyRequirement(requirements, snapshot);
    if (money > 0 && (!moneyNeeded || money > moneyNeeded.amount)) moneyNeeded = { faction, amount: money };
    // Gym time only once combat is all that's left (onlyCombatLeft).
    if (found || !onlyCombatLeft(requirements, snapshot)) continue;
    const blocking = findBlockingRequirement(requirements, snapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, snapshot);
    if (action.kind !== "none" && action.kind !== "commitCrime") found = { faction, action };
  }
  return { action: found, moneyNeeded, blockers };
}

// Whether the favor plan was already ready last tick - so "ready" is logged
// once when it happens, not every 5 seconds.
let favorPlanWasReady = false;

/**
 * Corporate factions worth an invite (companyTargets): not joined, selling
 * a useful augmentation not owned, short of the company rep their invite
 * needs. Applies at each employer without a job, and again otherwise -
 * applyToCompany is also how promotions (more rep per minute) happen.
 * Applying takes no time; the work itself is the sleeves' (sleeve_daemon.ts).
 */
async function gatherCompanyTargets(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  joinedFactions: string[],
  owned: string[],
  jobs: Partial<Record<string, string>>,
  usefulStats: string[]
): Promise<CompanyTarget[]> {
  const ownedSet = new Set(owned);
  const candidates: CompanyTarget[] = [];
  for (const faction of COMPANY_FACTION_NAMES) {
    if (joinedFactions.includes(faction)) continue;
    const wanted = ns.singularity
      .getAugmentationsFromFaction(faction as FactionNameType)
      .some((name) => name !== NEUROFLUX_GOVERNOR && !ownedSet.has(name) && matchesFocus(ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>, usefulStats));
    if (!wanted) continue;
    const need = companyRepRequirement(ns.singularity.getFactionInviteRequirements(faction as FactionNameType));
    if (!need) continue;
    const before = jobs[need.company];
    const job = ns.singularity.applyToCompany(need.company as CompanyNameType, config.companyJobField as JobFieldType);
    if (job && job !== before) await log.info(`[Faction] ${before ? "Promoted" : "Hired"} at ${need.company}: ${job} (toward the ${faction} invite).`);
    candidates.push({ faction, company: need.company, rep: ns.singularity.getCompanyRep(need.company as CompanyNameType), needed: need.reputation });
  }
  return companyTargets(candidates);
}

/** Whether any wanted, not-yet-joined faction's invite is blocked on combat stats (combatBlocksInvite). */
function wantedInvitesNeedCombat(ns: NS, config: FactionConfig, snapshot: EligibilitySnapshot, joinedFactions: string[], owned: string[]): boolean {
  const offered: Record<string, string[]> = {};
  for (const faction of config.pursueAugmentationFactions) {
    // Without pursueRedPill, The Red Pill doesn't make a faction worth an
    // invite (Daedalus sells nothing else but NeuroFlux).
    offered[faction] = ns.singularity
      .getAugmentationsFromFaction(faction as FactionNameType)
      .filter((name) => config.pursueRedPill || name !== RED_PILL);
  }
  const shop = readFreshJson<SleevesFile>(ns, SLEEVES_PATH, 120_000)?.shop;
  const alsoWanted = shop && Number.isFinite(shop.nextSleeveCost) ? [COVENANT] : [];
  return wantedInviteFactions(config.pursueAugmentationFactions, joinedFactions, offered, owned, alsoWanted).some((faction) =>
    combatBlocksInvite(ns.singularity.getFactionInviteRequirements(faction as FactionNameType), snapshot)
  );
}

// Each ground faction's rep over time (measureGrinds) - survives ticks, not restarts.
const grindSamples = new Map<string, RepSample[]>();
// Rep/min is measured over this window, once there's at least the minimum span.
const GRIND_WINDOW_MS = 10 * 60_000;
const GRIND_MIN_SPAN_MS = 2 * 60_000;

/**
 * Every favor-plan faction being ground - the player's work target and
 * each sleeve's faction - with its rep/min from actual rep growth (so
 * share and every worker count), time to its favor target, and what
 * installing now would do (installNowEstimate).
 */
function measureGrinds(
  ns: NS,
  config: FactionConfig,
  factions: string[],
  reps: Record<string, number>,
  favors: Record<string, number>,
  plan: FavorPlanEntry[]
): GrindStatus[] {
  const now = Date.now();
  for (const faction of [...grindSamples.keys()]) if (!factions.includes(faction)) grindSamples.delete(faction);
  const grinds: GrindStatus[] = [];
  for (const faction of factions) {
    const rep = reps[faction] ?? 0;
    const samples = addRepSample(grindSamples.get(faction) ?? [], { t: now, rep }, GRIND_WINDOW_MS);
    grindSamples.set(faction, samples);
    const repPerMin = measuredRepPerMin(samples, GRIND_MIN_SPAN_MS);
    const entry = plan.find((e) => e.faction === faction);
    if (!entry || repPerMin === undefined || !ns.fileExists("Formulas.exe", "home")) continue;
    const favor = favors[faction] ?? 0;
    const gap = Math.max(0, entry.target - rep);
    if (gap <= 0) continue;
    const estimate = installNowEstimate(
      rep,
      favor,
      gap,
      repPerMin,
      (f) => ns.formulas.reputation.calculateFavorToRep(f),
      (r) => ns.formulas.reputation.calculateRepToFavor(r),
      config.grindInstallOverheadMinutes
    );
    grinds.push({
      faction,
      gap,
      repPerMin,
      etaMinutes: estimate.grindNowMinutes,
      favor,
      installFavor: estimate.favorAfter,
      installEtaMinutes: estimate.afterInstallMinutes,
    });
  }
  return grinds;
}

/**
 * Whether installing `pending` now reaches the GROW_STATS hacking goal
 * sooner than continuing to study (compareInstall's ratio at or under
 * growStatsInstallMaxRatio). Without Formulas.exe it can't tell, so no.
 */
async function growStatsInstallSaves(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  player: ReturnType<NS["getPlayer"]>,
  pending: PendingBoost
): Promise<boolean> {
  if (!ns.fileExists("Formulas.exe", "home")) return false;
  const level = player.skills.hacking;
  const exp = player.exp.hacking;
  const { mult } = skillMultiplier("hacking", player.mults.hacking, readBitNodeInfo(ns)?.multipliers, () =>
    effectiveSkillMult(level, (m) => ns.formulas.skills.calculateSkill(exp, m))
  );
  if (mult === undefined) return false;

  const goal = hackingGoal(config.growStatsHackingGoal, ns.serverExists(WORLD_DAEMON) ? ns.getServerRequiredHackingLevel(WORLD_DAEMON) : undefined);
  const boost = pending.multipliers;
  const c = compareInstall(goal, exp, mult, boost.hacking ?? 1, boost.hacking_exp ?? 1, (lvl, m) => ns.formulas.skills.calculateExp(lvl, m));
  const saves = c.ratio <= config.growStatsInstallMaxRatio;
  await log.debug(
    `[Faction] GROW_STATS install check: goal=${goal} level=${level} pending=${pending.count} ` +
      `level x${(boost.hacking ?? 1).toFixed(3)} exp x${(boost.hacking_exp ?? 1).toFixed(3)} ratio=${c.ratio.toFixed(2)} -> ${saves ? "install" : "hold"}`
  );
  return saves;
}


async function tick(ns: NS, log: Logger, config: FactionConfig): Promise<void> {
  const playerRes = await player_metadata_pb
    .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
    .GetPlayerMetadata({});
  const money = playerRes.data?.player?.money ?? 0;

  const invitations = ns.singularity.checkFactionInvitations();
  const toJoin = decideFactionsToJoin(invitations, ns.getPlayer().factions, config.joinAllowlist);
  for (const faction of toJoin) {
    if (ns.singularity.joinFaction(faction as FactionNameType)) await log.info(`[Faction] Joined ${faction}.`);
  }

  // Re-read rather than reuse the pre-join snapshot - joinFaction takes
  // effect immediately, so this reflects any joins from the loop above
  // within the same tick instead of waiting until next tick to see them.
  // Captured once as a full Player object - both `.factions` (as before)
  // and the eligibility snapshot below come from this single call.
  const player = ns.getPlayer();
  const joinedFactions = player.factions;

  const reps: Record<string, number> = joinedFactions.length > 0 ? gatherReps(ns, joinedFactions) : {};
  // Without pursueRedPill, The Red Pill is left out of everything - rep
  // targets, the favor plan, priority work, savings - so the BitNode isn't
  // pushed toward its end (e.g. BN10 kept running to buy Covenant sleeves).
  const catalog: AugmentationInfo[] = (joinedFactions.length > 0 ? gatherCatalog(ns, joinedFactions) : []).filter(
    (aug) => config.pursueRedPill || aug.name !== RED_PILL
  );
  const owned = ns.singularity.getOwnedAugmentations(true);
  const pending = getPendingAugmentations(ns);
  const pendingBoost: PendingBoost = {
    count: pending.length,
    multipliers: combineMultipliers(pending.map((name) => ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>)),
    writtenAt: Date.now(),
  };
  ns.write(PENDING_BOOST_PATH, JSON.stringify(pendingBoost), "w");

  // GROW_STATS (scheduler.proto) hands the player's work slot to
  // study_daemon.ts, so neither faction work nor eligibility work below
  // claims it - otherwise each would restart over the other every tick.
  // From the scheduler's config file, not RPC - see approach.ts for the
  // post-install timeout that silently dropped AUGMENTS mode.
  // The phase from the game (derivePhase), published for every other
  // daemon; an explicit approach in /etc/scheduler.txt overrides it.
  const gangPossible = bitNodeGrants(readBitNodeInfo(ns), 2);
  const inGang = gangPossible && ns.gang.inGang();
  const gangFactionName = inGang ? ns.gang.getGangInformation().faction : undefined;
  const hackingMult = player.mults.hacking * (readBitNodeInfo(ns)?.multipliers?.HackingLevelMultiplier ?? 1);
  const neededMult = requiredHackingMult(config.finishHackingLevel, config.finishExpBudget);
  const phase = derivePhase({
    gangAvailable: gangPossible,
    inGang,
    donationReady: joinedFactions.some((f) => f !== gangFactionName && ns.singularity.getFactionFavor(f as FactionNameType) >= ns.getFavorToDonate()),
    pursueFinish: config.pursueRedPill,
    hackingMult,
    requiredHackingMult: neededMult,
    inDaedalus: joinedFactions.includes(DAEDALUS),
  });
  ns.write(PHASE_PATH, JSON.stringify({ ...phase, writtenAt: Date.now() } satisfies PhaseFile), "w");
  const policy = phasePolicy(parseApproachOverride(ns.read(SCHEDULER_CONFIG_PATH)) ?? phase.approach);
  const growingStats = policy.studyForStats;
  // AUGMENTS (scheduler.proto): spending steered toward good augmentations -
  // see priorityFocus below.
  const augmentsMode = policy.installLoop;
  const grindMode = policy.grindFactions;

  // NeuroFlux Governor is decided once, here, for every path: only in the
  // pre-install spend-down, and only at factions with nothing else left
  // (see catalogsFor).
  // Only useful augmentations drive buying, work and favor (usefulCatalog),
  // in every mode; augmentationFocus narrows further in GROW_STATS/AUGMENTS.
  // Combat (secondaryAugmentationStats) is useful only while a wanted
  // invite is blocked on combat stats (combatBlocksInvite).
  const combatNeeded = wantedInvitesNeedCombat(ns, config, gatherEligibilitySnapshot(player), joinedFactions, owned);
  const usefulStats = [...config.usefulAugmentationStats, ...(combatNeeded ? config.secondaryAugmentationStats : [])];
  const useful = usefulCatalog(catalog, usefulStats);
  const catalogs = catalogsFor(useful, owned);

  // Earning an invite to a faction that sells something still wanted beats
  // grinding rep where we already are (pursueWantedInvites) - e.g. gym time
  // for Illuminati's combat requirement after an install dropped it.
  const snapshot = gatherEligibilitySnapshot(player);

  // GANG (scheduler.proto): until a gang exists, the work slot lowers karma
  // with the fastest crime (pickKarmaCrime) - ahead of invites and faction
  // work. gang_daemon.ts creates the gang once karma allows.
  const gangAvailable = gangPossible;
  // Never the gang's own faction for work, favor or rep targets (see workableFactions).
  const gangFaction = gangAvailable && ns.gang.inGang() ? ns.gang.getGangInformation().faction : undefined;
  const workable = workableFactions(joinedFactions, gangFaction);
  const karmaCrime =
    policy.chaseGangKarma && gangAvailable && !ns.gang.inGang() && karmaBlocksGang(player.karma, readBitNodeInfo(ns)?.node)
      ? pickKarmaCrimeLive(ns)
      : undefined;
  // Gym instead of the crime only while that reaches the karma requirement
  // sooner (trainingPaysOff, by formula); without Formulas.exe, while the
  // chance is below gangCrimeMinChance. Only if the gym is affordable.
  const karmaCrimeChance = karmaCrime ? ns.singularity.getCrimeChance(karmaCrime as CrimeTypeType) : 0;
  const trainStat = karmaCrime ? decideGangTraining(ns, config, player, karmaCrime, karmaCrimeChance, snapshot) : undefined;
  const karmaAction: EligibilityAction | undefined = !karmaCrime
    ? undefined
    : trainStat && gymAffordable(ns, ns.enums.GymType[trainStat], config.gymLocation)
      ? { kind: "gymWorkout", stat: trainStat }
      : { kind: "commitCrime", crime: karmaCrime };
  if (karmaAction) {
    // Not counted toward crimeAttempts - that circuit breaker bounds
    // crime-for-kills, which this isn't.
    await executeEligibilityAction(ns, log, karmaAction, config.gymLocation);
  }

  const invite = growingStats || karmaCrime ? undefined : pursueWantedInvites(ns, config, snapshot, joinedFactions, owned);
  const inviteAction: EligibilityAction = invite?.action?.action ?? { kind: "none" };

  // Favor plan (favorPlan): work each faction whose augmentation is cheaper
  // to reach by donation favor only up to that favor, then move on.
  const favors: Record<string, number> = Object.fromEntries(
    joinedFactions.map((faction) => [faction, ns.singularity.getFactionFavor(faction as FactionNameType)])
  );
  // FACTION_GRIND aims at the one faction closest to donation favor
  // (donationTarget); otherwise factions selling something dearer than favor.
  const favorToRep = (favor: number): number => ns.formulas.reputation.calculateFavorToRep(favor);
  const formulas = ns.fileExists("Formulas.exe", "home");
  const target = formulas && policy.donationTarget ? donationTarget(workable, reps, favors, ns.getFavorToDonate(), favorToRep) : undefined;
  const plan = !growingStats && formulas ? (target ? [target] : favorPlan(workable, reps, favors, useful, owned, ns.getFavorToDonate(), favorToRep)) : [];
  const planReady = favorPlanReady(plan);
  if (planReady && !favorPlanWasReady) {
    await log.info(
      `[Faction] Favor plan ready: ${plan.map((e) => `${e.faction} ${e.rep.toFixed(0)}/${e.target.toFixed(0)}`).join(", ")}. ` +
        "Installing now gives each of them donation favor - turn on autoInstall (an augmentation must be pending)."
    );
  }
  favorPlanWasReady = planReady;

  // Factions that accept donations (favor >= getFavorToDonate()): cash buys
  // their rep, so they're never ground (decideWorkTarget/repTargets), and
  // The Red Pill can take over purchases (redPillFocus).
  const donatable =
    config.autoPurchaseAugmentations && config.autoDonate && ns.fileExists("Formulas.exe", "home")
      ? donatableFactions(ns, joinedFactions, gangAvailable)
      : new Set<string>();
  // Rep is ground only up to where cash takes over (favor targets); never
  // for NeuroFlux, whose rep is bought with its price once donations open.
  // DAEDALUS before the invite: rep elsewhere buys nothing that will be
  // installed, so the slot goes free - study_daemon.ts studies for hacking.
  const waitingForDaedalus = policy.redPillOnly && !joinedFactions.includes(DAEDALUS);
  const workTarget =
    !growingStats && !karmaCrime && !waitingForDaedalus && inviteAction.kind === "none" && joinedFactions.length > 0
      ? decideWorkTarget(workable, reps, catalogs.regular, owned, plan, donatable)
      : undefined;
  const work = workTarget ? pickWorkType(ns, workTarget, player) : undefined;
  // Factions being ground: the player's target plus each sleeve's.
  const sleeveFactions = (readFreshJson<SleevesFile>(ns, SLEEVES_PATH, 120_000)?.sleeves ?? [])
    .map((s) => /^faction work: (.+)$/.exec(s.goal)?.[1])
    .filter((f): f is string => !!f);
  const grinds = measureGrinds(ns, config, [...new Set([...(workTarget ? [workTarget] : []), ...sleeveFactions])], reps, favors, plan);
  const companyGoals = config.pursueCompanyTargets
    ? await gatherCompanyTargets(ns, log, config, joinedFactions, owned, player.jobs as Partial<Record<string, string>>, usefulStats)
    : [];
  // The finish line itself: launch tools/finish_bitnode.js once (it checks
  // everything again before destroying the World Daemon).
  const worldVisible = ns.serverExists(WORLD_DAEMON);
  const finishReady = readyToFinish(
    ns.singularity.getOwnedAugmentations(false).includes(RED_PILL),
    worldVisible,
    player.skills.hacking,
    worldVisible ? ns.getServerRequiredHackingLevel(WORLD_DAEMON) : Infinity
  );
  if (finishReady && config.nextBitNode > 0 && !finishLaunched) {
    if (ns.run(FINISH_TOOL, 1, config.nextBitNode, "--confirm") !== 0) {
      finishLaunched = true;
      await log.info(`[Faction] The BitNode can be finished: running ${FINISH_TOOL} ${config.nextBitNode} --confirm.`);
    } else {
      await log.warn(`[Faction] The BitNode can be finished, but ${FINISH_TOOL} couldn't start (RAM?); retrying.`);
    }
  }
  const repsFile: FactionRepsFile = {
    finishReady,
    nextBitNode: config.nextBitNode,
    hackingMult,
    requiredHackingMult: neededMult,
    companyTargets: companyGoals,
    inviteBlockers: invite?.blockers,
    favors,
    donatable: [...donatable],
    installedAugs: ns.singularity.getOwnedAugmentations(false).length,
    reps,
    repTargets: repTargets(workable, reps, catalogs.regular, owned, plan, donatable),
    workTarget,
    workType: work?.type,
    workGains: work?.gains,
    gymTraining: inviteAction.kind === "gymWorkout" || karmaAction?.kind === "gymWorkout",
    grinds,
    favorPlan: plan,
    favorPlanReady: planReady,
    karmaCrime: karmaCrime
      ? `${karmaAction?.kind === "gymWorkout" ? `training ${karmaAction.stat} for ` : ""}${karmaCrime} ` +
        `(${(karmaCrimeChance * 100).toFixed(0)}% success, karma ${player.karma.toFixed(0)} / ${GANG_KARMA_REQUIREMENT})`
      : undefined,
    inviteAction: invite?.action
      ? `${invite.action.faction}: ${inviteAction.kind}${inviteAction.kind === "gymWorkout" ? ` ${inviteAction.stat}` : ""}`
      : invite?.moneyNeeded
        ? `${invite.moneyNeeded.faction}: waiting for $${(invite.moneyNeeded.amount / 1e9).toFixed(0)}B cash`
        : undefined,
    writtenAt: Date.now(),
  };
  ns.write(FACTION_REPS_PATH, JSON.stringify(repsFile), "w");
  await executeEligibilityAction(ns, log, inviteAction, config.gymLocation);
  if (workTarget && work?.type && !isAlreadyWorking(ns, workTarget, work.type)) {
    ns.singularity.workForFaction(workTarget as FactionNameType, work.type as FactionWorkTypeType);
    const rates = work.gains ? ` (rep/min by formula: ${Object.entries(work.gains).map(([t, r]) => `${t}=${r.toFixed(0)}`).join(", ")})` : "";
    await log.info(`[Faction] Working ${work.type} for ${workTarget}${rates}.`);
  }

  // Active eligibility-seeking (full design in server_metadata.md) - runs
  // regardless of whether any faction is joined yet, since e.g. traveling
  // to a city or applying to a company is exactly how a fresh BitNode run
  // gets its FIRST faction, not just later ones.
  const state = loadState(ns);

  // Travel never touches the work slot, so it runs unconditionally
  // alongside whatever wins the work slot below - see pursueCityFactions'
  // own doc for the mutual-exclusivity short-circuit.
  // Also skipped during GROW_STATS: study_daemon.ts may need the player in
  // a different city (a university), and the two would travel back and forth.
  const cityAction: EligibilityAction = config.pursueCityFactions && !growingStats
    ? pursueCityFactions(ns, config, snapshot, joinedFactions)
    : { kind: "none" };
  await executeEligibilityAction(ns, log, cityAction, config.gymLocation);

  // Only tried when the work slot isn't already claimed by grinding rep
  // at an already-joined faction - see decideEligibilityWorkSlotAction's doc.
  const eligibilityAction: EligibilityAction =
    workTarget || growingStats || karmaCrime || inviteAction.kind !== "none"
    ? { kind: "none" }
    : await decideEligibilityWorkSlotAction(ns, log, config, state, snapshot, joinedFactions);
  const slotFile: WorkSlotFile = {
    free: !growingStats && workSlotFree(workTarget, inviteAction.kind, !!karmaCrime, eligibilityAction.kind),
    writtenAt: Date.now(),
  };
  ns.write(WORK_SLOT_PATH, JSON.stringify(slotFile), "w");
  const crimeAttempted = await executeEligibilityAction(ns, log, eligibilityAction, config.gymLocation);
  if (crimeAttempted) {
    state.crimeAttempts += 1;
    saveState(ns, state);
  }

  // 0.1% over the exact amount, so float rounding can't leave the rep a
  // hair short of the requirement.
  const donationForRep = (rep: number): number => Math.ceil(ns.formulas.reputation.donationForRep(rep, player) * 1.001);

  // The one augmentation everything is saved for, if any: in AUGMENTS the
  // most expensive reachable good one (priorityFocus); otherwise only The
  // Red Pill. While it exists it's the only thing bought or donated for,
  // with all cash rather than maxSpendFraction, and every other daemon holds
  // its spending to the savings target (savings.ts).
  // AUGMENTS cycle: only augmentations within maxFocusWaitMinutes of
  // income are saved for - the dearest of them first (focusPriceLimit).
  // With none left, the install goes ahead and resets the 1.9x inflation.
  // Once the pre-install wind-down has started nothing is held, or growing
  // cash would flip the hold back on mid-wind-down. The Red Pill is always
  // waited for (priorityFocus returns it regardless of price).
  const priceLimit =
    readInstallPending(ns) !== undefined
      ? 0
      : focusPriceLimit(money, incomePerMin(ns, INCOME_WINDOW_SEC), config.maxFocusWaitMinutes, pending.length);
  // What's bought or donated for - narrowed during GROW_STATS and AUGMENTS
  // to augmentationFocus, and in AUGMENTS to everything useful once no
  // focus augmentation is left reachable (focusStatsFor).
  const focusStats = focusStatsFor(
    policy.focusAugmentations,
    augmentsMode && priorityFocus(catalog, reps, owned, donatable, config.augmentationFocus) === undefined,
    config.augmentationFocus,
    usefulStats
  );
  const inFocus = (list: AugmentationInfo[]): AugmentationInfo[] =>
    focusStats ? list.filter((aug) => matchesFocus(aug.stats, focusStats)) : list;
  const buyCatalog = inFocus(catalogs.regular);
  // A Covenant sleeve within reach outranks every augmentation but The Red
  // Pill (sleeveSavings): it's saved for instead, and sleeve_daemon.ts buys it.
  const sleeveSave = sleeveSavings(
    readBitNodeInfo(ns)?.node,
    joinedFactions.includes(COVENANT),
    readFreshJson<SleevesFile>(ns, SLEEVES_PATH, 120_000)?.shop?.nextSleeveCost,
    money,
    incomePerMin(ns, INCOME_WINDOW_SEC),
    config.sleeveSaveMinutes
  );
  // Nothing pending and nothing within the (longer) cap: the cheapest
  // reachable one, so the loop always moves - one purchase starts the
  // install cycle.
  const candidateFocus = augmentsMode
    ? (priorityFocus(catalog, reps, owned, donatable, focusStats ?? config.augmentationFocus, priceLimit) ??
      (pending.length === 0 && readInstallPending(ns) === undefined
        ? priorityFocus(catalog, reps, owned, donatable, focusStats ?? config.augmentationFocus, Infinity, true)
        : undefined))
    : redPillFocus(catalog, reps, owned, donatable);
  const focusAug = sleeveSave > 0 && candidateFocus?.name !== RED_PILL ? undefined : candidateFocus;
  // The install loop is "on" only while an install is near: something
  // pending, or the saved-for augmentation within the short (5-minute)
  // cap. A long save (BN10: 9.3h for QLink) is a long phase - the Hacknet,
  // wiped by the last install, should rebuild through it.
  const shortCap = focusPriceLimit(money, incomePerMin(ns, INCOME_WINDOW_SEC), config.maxFocusWaitMinutes, 1);
  const loopFile: InstallLoopFile = {
    active: installLoopActive(
      augmentsMode,
      config.autoPurchaseAugmentations,
      config.autoInstall,
      pending.length,
      !!focusAug && focusAug.price <= shortCap
    ),
    writtenAt: Date.now(),
  };
  ns.write(INSTALL_LOOP_PATH, JSON.stringify(loopFile), "w");
  // DAEDALUS buys only The Red Pill: anything else would sit pending, and
  // its price would be cash not donated for Daedalus rep.
  const spendCatalog = focusAug ? [focusAug] : policy.redPillOnly ? [] : buyCatalog;
  const focusRepGap = focusAug ? Math.max(0, focusAug.repReq - (reps[focusAug.faction] ?? 0)) : 0;
  const focusSavings =
    focusAug && config.autoPurchaseAugmentations ? focusAug.price + (focusRepGap > 0 ? donationForRep(focusRepGap) : 0) : 0;
  // In AUGMENTS, a wanted invite's cash requirement is saved for too - it
  // only counts cash on hand, and anything spent below it delays the invite.
  const inviteSavings = augmentsMode || policy.redPillOnly ? (invite?.moneyNeeded?.amount ?? 0) : 0;
  const savingsAmount = Math.max(focusSavings, inviteSavings, focusAug ? 0 : sleeveSave);
  writeSavings(
    ns,
    savingsAmount,
    focusSavings >= inviteSavings && focusAug
      ? `${focusAug.name} from ${focusAug.faction}`
      : !focusAug && sleeveSave > 0 && sleeveSave >= inviteSavings
        ? SLEEVE_SAVINGS_REASON
        : `${invite?.moneyNeeded?.faction ?? ""} invite`
  );
  const spendFraction = focusAug ? 1 : config.maxSpendFraction;
  // The focus augmentation is what the savings are for; anything else must
  // stay above the invite's cash requirement.
  const spendReserve = focusAug ? config.reserveMoney : Math.max(config.reserveMoney, inviteSavings, sleeveSave);

  const purchaseDecision: PurchaseDecision = config.autoPurchaseAugmentations
    ? decideAugmentationPurchase(money, spendReserve, spendFraction, reps, spendCatalog, owned)
    : { kind: "none" };

  await log.debug(
    `[Faction] tick: money=$${money.toFixed(0)} joined=${joinedFactions.length} workTarget=${workTarget ?? "none"} ` +
      `pending=${pending.length} purchase=${purchaseDecision.kind === "buy" ? purchaseDecision.augmentation : "none"} ` +
      `city=${cityAction.kind} eligibility=${eligibilityAction.kind} crimeAttempts=${state.crimeAttempts} growStats=${growingStats} augments=${augmentsMode} ` +
      `focus=${focusAug ? `${focusAug.name} (saving $${(savingsAmount / 1e9).toFixed(1)}B)` : "none"}`
  );

  if (joinedFactions.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  // Keeps an in-progress wind-down alive while its freed cash gets spent.
  const refreshWindDown = (): void => {
    if (readInstallPending(ns)) touchInstallPending(ns, now);
  };

  if (purchaseDecision.kind === "buy") {
    if (ns.singularity.purchaseAugmentation(purchaseDecision.faction as FactionNameType, purchaseDecision.augmentation)) {
      await log.info(`[Faction] Purchased ${purchaseDecision.augmentation} from ${purchaseDecision.faction}.`);
    }
    if (config.autoInstall) refreshWindDown();
    // Re-derive fresh state (including the new pending list) next tick
    // before even considering install - never buy and install same-tick.
    return;
  }

  // Nothing purchasable outright - try buying the missing reputation with
  // money (decideDonation). The augmentation itself is bought next tick by
  // the normal purchase path above.
  const decideDonationWith = (reserveMoney: number, maxSpendFraction: number, list: AugmentationInfo[]): DonationDecision =>
    donatable.size > 0
      ? decideDonation(money, reserveMoney, maxSpendFraction, reps, list, owned, donatable, donationForRep)
      : { kind: "none" };

  const donation = decideDonationWith(spendReserve, focusAug ? 1 : config.donationSpendFraction, spendCatalog);
  if (donation.kind === "donate") {
    await executeDonation(ns, log, donation);
    if (config.autoInstall) refreshWindDown();
    return;
  }

  // During GROW_STATS an install resets the hacking experience being
  // studied up, so it only goes ahead when the pending augmentations'
  // multipliers more than make up for it (see growStatsInstallSaves).
  // Saving for a focus augmentation counts as a reserve too: an install
  // would wipe the savings (see decideInstallReady).
  // An install that banks favor (every favor target met, or FACTION_GRIND's
  // estimate says it pays) needs something pending: buy the cheapest
  // augmentation to make it possible (pickInstallEnabler).
  // In every mode: an install that banks favor is worth making possible.
  const installWanted = planReady || grindInstallPays(grinds);
  // Savings don't block it: the enabler costs millions, and with something
  // pending the focus cap drops back to 5 minutes, which clears the hold.
  if (installWanted && config.autoInstall && config.autoPurchaseAugmentations && pending.length === 0 && purchaseDecision.kind === "none") {
    const enabler = pickInstallEnabler(catalog, reps, owned, money);
    if (enabler && ns.singularity.purchaseAugmentation(enabler.faction as FactionNameType, enabler.name)) {
      await log.info(`[Faction] Bought ${enabler.name} from ${enabler.faction} so the install banking favor can happen (nothing else was pending).`);
      return;
    }
    if (!enabler) await log.warn("[Faction] An install would bank favor, but nothing is buyable to make one possible.");
  }
  const installReady = config.autoInstall && decideInstallReady(purchaseDecision, pending, config.reserveMoney + savingsAmount);
  const growStatsBlocks = installReady && growingStats && !(await growStatsInstallSaves(ns, log, config, player, pendingBoost));
  // FACTION_GRIND installs only once every favor target is met (grindAllowsInstall).
  const grindBlocks = installReady && grindMode && !grindAllowsInstall(plan, grinds);
  // DAEDALUS installs only to bank favor (every target met) or to install
  // The Red Pill - any other install resets the hacking level being built.
  const daedalusBlocks = installReady && policy.redPillOnly && !(pending.includes(RED_PILL) || planReady);
  if (!installReady || growStatsBlocks || grindBlocks || daedalusBlocks) {
    if (readInstallPending(ns)) {
      clearInstallPending(ns);
      await log.info(
        `[Faction] Install no longer ready (autoInstall off, not worth it during GROW_STATS, or FACTION_GRIND favor targets unmet) - cancelling the wind-down; stock trading resumes.`
      );
    }
    return;
  }

  // Everything left is spent before the install wipes cash and stock - see
  // decidePreInstall and system/install_handshake.ts.
  // The only place NeuroFlux can be bought: the cash is about to be wiped,
  // and only at factions with nothing else left (catalogsFor).
  const finalCatalog = focusAug ? [focusAug] : inFocus(catalogs.preInstall);
  const finalPurchase: PurchaseDecision = config.autoPurchaseAugmentations
    ? decideAugmentationPurchase(money, 0, 1, reps, finalCatalog, owned)
    : { kind: "none" };
  if (finalPurchase.kind === "none") {
    // Same whole-balance rule as finalPurchase: the install is about to
    // wipe this cash, so rep bought now is the last thing it can become.
    const finalDonation = decideDonationWith(0, 1, finalCatalog);
    if (finalDonation.kind === "donate") {
      await executeDonation(ns, log, finalDonation);
      refreshWindDown();
      return;
    }
  }
  const heldPositions = stockPositionsHeld(ns);
  const action = decidePreInstall(finalPurchase, heldPositions);

  if (action.kind === "buy") {
    if (ns.singularity.purchaseAugmentation(action.faction as FactionNameType, action.augmentation)) {
      await log.info(`[Faction] Pre-install: purchased ${action.augmentation} from ${action.faction} with the remaining cash.`);
    }
    refreshWindDown();
    return;
  }

  if (action.kind === "wind-down") {
    const starting = !readInstallPending(ns);
    touchInstallPending(ns, now);
    if (starting) {
      await log.info(
        `[Faction] Install ready, but ${heldPositions} stock position(s) are still held and an install deletes them with no refund. ` +
          "Asking stock_daemon.js to sell everything; the cash will be spent on augmentations before installing."
      );
    } else {
      await log.debug(`[Faction] Wind-down: waiting on stock_daemon.js to sell ${heldPositions} position(s).`);
    }
    return;
  }

  // Spend-down stage: augmentations are done and stock is sold, so the cash
  // left would just be wiped. Spend it on what survives an install - home
  // RAM here, gang equipment in gang_daemon.ts (both watch the phase) - and
  // install once cash stops dropping (nothing affordable left).
  const pendingState = readInstallPending(ns);
  const nowMs = Date.now();
  const spendDown = advanceSpendDown(pendingState?.spendDown, ns.getServerMoneyAvailable("home"), nowMs);
  const starting = pendingState?.phase !== "spendDown";
  if (starting) {
    await log.info("[Faction] Augmentations done; spending the rest on gang equipment and home RAM before installing.");
  }
  for (let i = 0; i < 50; i++) {
    const ramCost = ns.singularity.getUpgradeHomeRamCost();
    if (!(ramCost <= ns.getServerMoneyAvailable("home")) || !ns.singularity.upgradeHomeRam()) break;
    await log.info(`[Faction] Pre-install: upgraded home RAM to ${ns.getServerMaxRam("home")} GB ($${ramCost.toFixed(0)}).`);
  }
  writeInstallPending(ns, { since: pendingState?.since ?? now, heartbeat: now, phase: "spendDown", spendDown });
  if (starting || !spendDownSettled(spendDown, nowMs, SPEND_DOWN_SETTLE_MS)) return;

  clearInstallPending(ns);
  // One line per install (system/history.ts): what each install was worth,
  // in which phase, and where the finish line stood.
  const lastInstall = ns.read(INSTALL_HISTORY_PATH).trim().split("\n").pop();
  const lastAt = lastInstall ? (JSON.parse(lastInstall) as { at?: number }).at : undefined;
  ns.write(
    INSTALL_HISTORY_PATH,
    appendJsonLine(
      ns.read(INSTALL_HISTORY_PATH),
      {
        at: Date.now(),
        minutesSinceLast: lastAt ? (Date.now() - lastAt) / 60_000 : undefined,
        phase: Approach[phase.approach],
        reason: phase.reason,
        augmentations: pending,
        installedBefore: ns.singularity.getOwnedAugmentations(false).length,
        hackingLevel: player.skills.hacking,
        hackingMult,
        requiredHackingMult: neededMult,
        favors,
        plan: plan.map((e) => ({ faction: e.faction, rep: Math.round(e.rep), target: Math.round(e.target) })),
      },
      INSTALL_HISTORY_CAP
    ),
    "w"
  );
  await log.info(`[Faction] Installing ${pending.length} augmentation(s) and rebooting into ${config.bootScript}...`);
  ns.singularity.installAugmentations(config.bootScript);
}

/**
 * Joined factions that accept donations: favor >= getFavorToDonate(), and
 * never the gang's own faction (donateToFaction always refuses it). The gang
 * check is skipped entirely without Source-File 2, where ns.gang would throw.
 */
function donatableFactions(ns: NS, joinedFactions: string[], gangAvailable: boolean): Set<string> {
  const threshold = ns.getFavorToDonate();
  const gangFaction = gangAvailable && ns.gang.inGang() ? ns.gang.getGangInformation().faction : undefined;
  return new Set(
    joinedFactions.filter((faction) => faction !== gangFaction && ns.singularity.getFactionFavor(faction as FactionNameType) >= threshold)
  );
}

async function executeDonation(ns: NS, log: Logger, donation: { faction: string; augmentation: string; amount: number }): Promise<void> {
  const amount = `$${(donation.amount / 1e9).toFixed(2)}B`;
  if (ns.singularity.donateToFaction(donation.faction as FactionNameType, donation.amount)) {
    await log.info(`[Faction] Donated ${amount} to ${donation.faction} to cover the reputation for ${donation.augmentation}.`);
  } else {
    await log.warn(`[Faction] Donation of ${amount} to ${donation.faction} (for ${donation.augmentation}) was refused.`);
  }
}

/** Symbols with any shares held, long or short. 0 without TIX API access - every other ns.stock call needs it. */
function stockPositionsHeld(ns: NS): number {
  if (!ns.stock.hasTixApiAccess()) return 0;
  return ns.stock.getSymbols().filter((sym) => {
    const [long, , short] = ns.stock.getPosition(sym);
    return long > 0 || short > 0;
  }).length;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so every tick's reasoning is visible, same as hacknet_daemon.ts/
  // purchased_server_daemon.ts/scheduler_daemon.ts.
  const log = createLogger(ns, "Faction", LOG_LEVEL.DEBUG);

  await log.info("=== Faction manager online ===");

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      await tick(ns, log, config);
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
