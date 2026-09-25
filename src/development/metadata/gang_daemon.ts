import { GangGenInfo, NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { GangPosture } from "development/metadata/gang";
import {
  AscensionCandidate,
  averageMultiplier,
  decideEquipmentPurchase,
  decideMemberTask,
  decideStandDown,
  decideTerritoryReadiness,
  decideTerritoryWarfareAssignment,
  decideTrainingTask,
  detectCasualties,
  EquipmentOption,
  selectBestAscensionCandidate,
  TaskOption,
} from "development/metadata/gang_decisions";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

/**
 * Manages an *already-created* gang - task assignment, equipment
 * purchases, ascension, and recruiting. Doesn't automate creating the
 * gang itself (ns.gang.createGang), which needs sufficiently negative
 * karma outside BitNode 2 (i.e. automating crime) - out of scope here,
 * see server_metadata.md. `tick()` below simply idles until
 * ns.gang.inGang() is true.
 *
 * Unlike ns.singularity, ns.gang functions have normal fixed RAM costs
 * (no Source-File multiplier - confirmed in NetscriptDefinitions.d.ts),
 * so this doesn't need the same single-file isolation invariant
 * program_shopper.ts/backdoor_daemon.ts/faction_daemon.ts have. It's
 * still its own daemon purely for the same config/log modularity reason
 * Hacknet and purchased-server are split. Only launched by boot.ts when
 * PlayerMetadata.gangAvailable is true (Source-File 2, independent of
 * singularityAvailable's Source-File 4).
 *
 * Task scoring is entirely ns.formulas.gang-driven (0 GB, gated by
 * Formulas.exe - already owned, same as the Hacknet ROI mode): unlike
 * GangTaskStats, which has no discrete "task type" field to distinguish
 * a money task from a wanted-reducing one, ns.formulas.gang.moneyGain/
 * wantedLevelGain give real per-tick numbers for any member+task pairing,
 * so gang_decisions.ts never needs to pattern-match task names. No
 * non-formula fallback mode exists here (unlike Hacknet) - without
 * Formulas.exe this daemon just idles.
 *
 * Territory (GangPosture, gang.proto): confirmed against Bitburner's own
 * source that 0% territory suppresses money/respect gains by orders of
 * magnitude, but gang power only ever accrues from members assigned to
 * the "Territory Warfare" task, and does so unconditionally regardless of
 * whether real clashes are engaged - see gang_decisions.ts's module doc.
 * So GangPosture.GROWING always trains power risk-free, and only calls
 * ns.gang.setTerritoryWarfare(true) once decideTerritoryReadiness says
 * every rival holding territory is currently a favorable matchup.
 * config.posture is a hand-editable string ("CONSOLIDATE"/"GROWING"),
 * not the raw numeric GangPosture value, so /etc/gang.txt stays as
 * readable as every other config file in this codebase - parsePosture
 * converts it at the point of use, same boundary-casting pattern
 * hacknet_daemon.ts already uses for HashUpgradeName/FactionNameType.
 */
export type GangConfig = {
  enabled: boolean;
  reserveMoney: number;
  maxSpendFraction: number;
  // GangGenInfo.wantedPenalty is a multiplier (1.0 = no penalty, dropping
  // toward 0 as wanted level outgrows respect - confirmed against live
  // logs, see gang_decisions.ts) - this is the floor below which members
  // get reassigned to wanted-control duty, not a ceiling.
  minWantedPenalty: number;
  wantedReductionFraction: number;
  minAscensionGainMultiplier: number;
  // Once a member's average trained-stat gain is within this fraction of
  // minAscensionGainMultiplier (e.g. 0.95 * 1.1 = 1.045), they're pulled
  // into a dedicated training task (0 money/respect/wanted, 100% stat
  // exp - see gang_decisions.ts's decideTrainingTask doc) instead of
  // their normal money/wanted-control task, to finish crossing the
  // ascension threshold faster. Reactive, not a standing reservation -
  // members far from ascending keep earning normally.
  trainingReadyMargin: number;
  // "CONSOLIDATE" (default) never touches Territory Warfare at all -
  // zero risk, today's behavior. "GROWING" trains power and, once ready,
  // engages real clashes - see the module doc above.
  posture: "CONSOLIDATE" | "GROWING";
  territoryWarfareMembers: number;
  // Safety margin before actually engaging clashes - comfortably past
  // the 0.5 break-even point, not just barely favorable.
  minClashWinChance: number;
  // A single permanent member death (see gang_decisions.ts's
  // decideStandDown doc) is enough to stand down until the user
  // explicitly reviews and resets /var/gang_state.txt.
  maxCasualties: number;
};

export const DEFAULT_CONFIG: GangConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  minWantedPenalty: 0.9,
  wantedReductionFraction: 0.2,
  minAscensionGainMultiplier: 1.1,
  trainingReadyMargin: 0.95,
  posture: "CONSOLIDATE",
  territoryWarfareMembers: 2,
  minClashWinChance: 0.65,
  maxCasualties: 1,
};

export const CONFIG_PATH = "/etc/gang.txt";
const STATE_PATH = "/var/gang_state.txt";
const TICK_INTERVAL_MS = 5000;
const TERRITORY_WARFARE_TASK = "Territory Warfare";

export type GangState = { lastKnownMemberCount: number; casualties: number };
const DEFAULT_STATE: GangState = { lastKnownMemberCount: 0, casualties: 0 };

export function loadState(ns: NS): GangState {
  return loadJsonConfig(ns, STATE_PATH, DEFAULT_STATE);
}

function saveState(ns: NS, state: GangState): void {
  ns.write(STATE_PATH, JSON.stringify(state, null, 2), "w");
}

function parsePosture(posture: GangConfig["posture"]): GangPosture {
  return posture === "GROWING" ? GangPosture.GROWING : GangPosture.CONSOLIDATE;
}

/** First name of the form "Member-N" not already in use. */
function nextMemberName(existing: Set<string>): string {
  let index = existing.size;
  let name = `Member-${index}`;
  while (existing.has(name)) {
    index++;
    name = `Member-${index}`;
  }
  return name;
}

/**
 * Runs decideMemberTask's money/wanted-control logic over `memberNames`
 * only - callers pass whichever members weren't carved off for Territory
 * Warfare (see assignTerritoryWarfare below), so index/totalMembers here
 * are already re-based to that remaining subset, keeping the
 * wanted-control reservation fraction meaningful for whoever's actually
 * eligible for it.
 */
function assignTasks(ns: NS, gang: GangGenInfo, config: GangConfig, memberNames: string[]): void {
  const members = new Map(memberNames.map((name) => [name, ns.gang.getMemberInformation(name)]));
  const tasks = ns.gang.getTaskNames().map((name) => ns.gang.getTaskStats(name));

  memberNames.forEach((name, index) => {
    const member = members.get(name);
    if (!member) return;

    const options: TaskOption[] = tasks.map((task) => ({
      name: task.name,
      moneyGain: ns.formulas.gang.moneyGain(gang, member, task),
      wantedLevelGain: ns.formulas.gang.wantedLevelGain(gang, member, task),
      respectGain: ns.formulas.gang.respectGain(gang, member, task),
    }));

    const chosen = decideMemberTask(
      index,
      memberNames.length,
      gang.wantedPenalty,
      { minWantedPenalty: config.minWantedPenalty, wantedReductionFraction: config.wantedReductionFraction },
      options
    );

    if (chosen && chosen !== member.task) ns.gang.setMemberTask(name, chosen);
  });
}

/**
 * Carves off whichever of `memberNames` are close enough to ascending to
 * benefit from a dedicated training task (see decideTrainingTask's doc -
 * 0 money/respect/wanted, 100% stat exp) - returns the rest, for
 * assignTasks to run its normal money/wanted-control logic over. Mirrors
 * assignTerritoryWarfare's carve-then-return-remainder shape.
 */
function assignTraining(ns: NS, gang: GangGenInfo, config: GangConfig, memberNames: string[]): string[] {
  const remaining: string[] = [];
  for (const name of memberNames) {
    const trainingTask = decideTrainingTask(
      ns.gang.getAscensionResult(name),
      config.minAscensionGainMultiplier,
      config.trainingReadyMargin,
      gang.isHacking
    );
    if (!trainingTask) {
      remaining.push(name);
      continue;
    }

    const member = ns.gang.getMemberInformation(name);
    if (member.task !== trainingTask) ns.gang.setMemberTask(name, trainingTask);
  }
  return remaining;
}

/** Carves `memberNames` onto the "Territory Warfare" task - training power risk-free (see module doc); a no-op for anyone already assigned there. */
function assignTerritoryWarfare(ns: NS, memberNames: string[]): void {
  for (const name of memberNames) {
    const member = ns.gang.getMemberInformation(name);
    if (member.task !== TERRITORY_WARFARE_TASK) ns.gang.setMemberTask(name, TERRITORY_WARFARE_TASK);
  }
}

/**
 * Engages/disengages real clashes to match decideTerritoryReadiness's
 * answer, only calling setTerritoryWarfare when the desired state
 * actually differs from what's already engaged (same discipline as the
 * ns.singularity.workForFaction fix - avoid restarting an already-correct
 * state every tick for no reason).
 */
async function manageTerritoryEngagement(
  ns: NS,
  log: Logger,
  config: GangConfig,
  gang: GangGenInfo,
  territoryWarfareCount: number,
  standDown: boolean
): Promise<void> {
  let shouldEngage = false;
  if (territoryWarfareCount > 0 && !standDown) {
    const rivalPowers = Object.values(ns.gang.getAllGangInformation())
      .filter((rival) => rival.territory > 0)
      .map((rival) => rival.power);
    shouldEngage = decideTerritoryReadiness(gang.power, rivalPowers, config.minClashWinChance);
  }

  if (shouldEngage !== gang.territoryWarfareEngaged) {
    ns.gang.setTerritoryWarfare(shouldEngage);
    await log.info(`[Gang] ${shouldEngage ? "Engaging" : "Disengaging"} territory warfare.`);
  }
}

async function purchaseEquipmentIfAffordable(ns: NS, log: Logger, config: GangConfig, memberNames: string[]): Promise<void> {
  const playerRes = await player_metadata_pb
    .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
    .GetPlayerMetadata({});
  const money = playerRes.data?.player?.money ?? 0;

  const equipmentNames = ns.gang.getEquipmentNames();
  const candidates: EquipmentOption[] = [];
  for (const name of memberNames) {
    const member = ns.gang.getMemberInformation(name);
    for (const equipName of equipmentNames) {
      if (member.upgrades.includes(equipName) || member.augmentations.includes(equipName)) continue;
      candidates.push({ member: name, name: equipName, cost: ns.gang.getEquipmentCost(equipName) });
    }
  }

  const purchase = decideEquipmentPurchase(money, config.reserveMoney, config.maxSpendFraction, candidates);
  if (purchase && ns.gang.purchaseEquipment(purchase.member, purchase.name)) {
    await log.info(`[Gang] Purchased ${purchase.name} for ${purchase.member} ($${purchase.cost.toFixed(0)}).`);
  }
}

async function ascendIfWorthwhile(ns: NS, log: Logger, config: GangConfig, memberNames: string[]): Promise<void> {
  const candidates: AscensionCandidate[] = memberNames.map((member) => ({ member, result: ns.gang.getAscensionResult(member) }));

  const chosen = selectBestAscensionCandidate(candidates, config.minAscensionGainMultiplier);
  if (!chosen) return;

  if (ns.gang.ascendMember(chosen)) await log.info(`[Gang] Ascended ${chosen}.`);
}

/**
 * One-time, full detail dump of every gang member at startup - name,
 * current task, live moneyGain/wantedLevelGain, and the exact ascension
 * numbers decideAscension evaluates (including the trained-stats average
 * it's compared against). Added after a live debugging session where the
 * only way to tell "is ascension actually not clearing the threshold, or
 * is something still broken" was guessing from outside the game -
 * logged once at DEBUG rather than every tick to avoid spamming a dozen
 * lines every 5s for numbers that mostly don't change tick to tick.
 */
async function logMemberSnapshot(ns: NS, log: Logger): Promise<void> {
  for (const name of ns.gang.getMemberNames()) {
    const member = ns.gang.getMemberInformation(name);
    const ascensionResult = ns.gang.getAscensionResult(name);
    const ascensionSummary = ascensionResult
      ? `hack=${ascensionResult.hack.toFixed(3)} str=${ascensionResult.str.toFixed(3)} def=${ascensionResult.def.toFixed(3)} ` +
        `dex=${ascensionResult.dex.toFixed(3)} agi=${ascensionResult.agi.toFixed(3)} cha=${ascensionResult.cha.toFixed(3)} ` +
        `trainedAverage=${averageMultiplier(ascensionResult).toFixed(3)}`
      : "not possible right now";

    await log.debug(
      `[Gang] Member ${name}: task=${member.task} moneyGain=${member.moneyGain.toFixed(2)} wantedLevelGain=${member.wantedLevelGain.toFixed(3)} ` +
        `ascension=[${ascensionSummary}]`
    );
  }
}

async function tick(ns: NS, log: Logger, config: GangConfig): Promise<void> {
  if (!ns.gang.inGang()) {
    await log.debug("[Gang] Not in a gang yet; idling.");
    return;
  }

  if (!ns.fileExists("Formulas.exe", "home")) {
    await log.warn("[Gang] Formulas.exe not owned; task scoring needs it. Idling.");
    return;
  }

  const state = loadState(ns);

  let recruitedThisTick = 0;
  if (ns.gang.canRecruitMember()) {
    const name = nextMemberName(new Set(ns.gang.getMemberNames()));
    if (ns.gang.recruitMember(name)) {
      recruitedThisTick = 1;
      await log.info(`[Gang] Recruited ${name}.`);
    }
  }

  const memberNames = ns.gang.getMemberNames();
  if (memberNames.length === 0) return;

  const newCasualties = detectCasualties(state.lastKnownMemberCount, memberNames.length, recruitedThisTick);
  if (newCasualties > 0) {
    state.casualties += newCasualties;
    await log.error(`[Gang] Detected ${newCasualties} member death(s) since last tick! Cumulative casualties: ${state.casualties}.`);
  }
  if (newCasualties > 0 || state.lastKnownMemberCount !== memberNames.length) {
    state.lastKnownMemberCount = memberNames.length;
    saveState(ns, state);
  }

  const standDown = decideStandDown(state.casualties, config.maxCasualties);
  if (standDown) {
    await log.warn(
      `[Gang] Standing down from territory warfare - ${state.casualties} casualties >= maxCasualties (${config.maxCasualties}). ` +
        `Edit ${STATE_PATH}'s casualties back down (or delete the file) once you're ready to try again.`
    );
  }

  const posture = parsePosture(config.posture);
  const gang = ns.gang.getGangInformation();
  const territoryWarfareCount = decideTerritoryWarfareAssignment(posture, standDown, memberNames.length, config.territoryWarfareMembers);
  const territoryMembers = memberNames.slice(0, territoryWarfareCount);
  const remainingMembers = memberNames.slice(territoryWarfareCount);

  assignTerritoryWarfare(ns, territoryMembers);
  const trainableRemaining = assignTraining(ns, gang, config, remainingMembers);
  assignTasks(ns, gang, config, trainableRemaining);
  await purchaseEquipmentIfAffordable(ns, log, config, memberNames);
  await ascendIfWorthwhile(ns, log, config, memberNames);

  await manageTerritoryEngagement(ns, log, config, gang, territoryWarfareCount, standDown);

  await log.debug(
    `[Gang] tick: members=${memberNames.length} respect=${gang.respect.toFixed(0)} wantedPenalty=${gang.wantedPenalty.toFixed(3)} ` +
      `territory=${(gang.territory * 100).toFixed(1)}% posture=${config.posture} territoryWarfare=${territoryWarfareCount} ` +
      `training=${remainingMembers.length - trainableRemaining.length} power=${gang.power.toFixed(2)} engaged=${gang.territoryWarfareEngaged} ` +
      `casualties=${state.casualties} standDown=${standDown}`
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so every tick's reasoning is visible, same as the other daemons.
  const log = createLogger(ns, "Gang", LOG_LEVEL.DEBUG);

  await log.info("=== Gang manager online ===");

  let loggedStartupSnapshot = false;

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      if (!loggedStartupSnapshot && ns.gang.inGang()) {
        await logMemberSnapshot(ns, log);
        loggedStartupSnapshot = true;
      }
      await tick(ns, log, config);
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
