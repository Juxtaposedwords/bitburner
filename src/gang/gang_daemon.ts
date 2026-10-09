import { GangGenInfo, NS } from "@ns";
import { readPhasePolicy } from "system/phase";
import { isSpendDownActive, readInstallPending } from "system/install_handshake";
import { readBitNodeInfo } from "system/bitnode_info";
import { loadJsonConfig } from "system/config";
import { isRemote, pullState, pushState } from "system/remote_state";
import { deadlineIn } from "system/deadline";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import { GangPosture } from "gang/gang";
import {
  AscensionCandidate,
  averageMultiplier,
  decideEquipmentPurchase,
  decideMemberTask,
  gangObjective,
  ascensionThreshold,
  decideAscension,
  decideStandDown,
  decideTerritoryReadiness,
  GANG_STATUS_PATH,
  karmaBlocksGang,
  nextMemberName,
  skipEquipmentBeforeAscension,
  skipRecentlyAscended,
  stateForNode,
  GangStatusFile,
  worstClashWinChance,
  decideTerritoryWarfareAssignment,
  decideTrainingTask,
  detectCasualties,
  EquipmentOption,
  selectBestAscensionCandidate,
  TaskOption,
  GANG_FACTION_PRIORITY,
} from "gang/gang_decisions";
import * as player_metadata_pb from "system/rpc/player_metadata";
import * as server_metadata_pb from "system/rpc/server_metadata";

/**
 * Manages a gang - task assignment, equipment purchases, ascension, and
 * recruiting. Creating one (ns.gang.createGang) needs karma at
 * GANG_KARMA_REQUIREMENT outside BitNode 2; in Approach.GANG the faction
 * daemon commits crimes to get there, and `tick()` below creates the gang
 * with the first joined faction in config.gangFactionPriority as soon as
 * the game allows. Outside that mode it just idles until
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
  // While the gang has fewer than fullGangSize members, ascensions need this
  // bigger gain instead - ascending costs respect, and recruits come from
  // respect (see ascensionThreshold).
  earlyAscensionGainMultiplier: number;
  fullGangSize: number;
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
  // Members always kept earning (respect for recruits, wanted level, some
  // income) however many territoryWarfareMembers asks for.
  minEarningMembers: number;
  // Safety margin before actually engaging clashes - comfortably past
  // the 0.5 break-even point, not just barely favorable.
  minClashWinChance: number;
  // A single permanent member death (see gang_decisions.ts's
  // decideStandDown doc) is enough to stand down until the user
  // explicitly reviews and resets /var/gang_state.txt.
  maxCasualties: number;
  // Approach.GANG creates the gang with the first of these the player has
  // joined. Combat gangs only: the task scoring here assumes combat tasks,
  // so hacking gangs (NiteSec, The Black Hand) are left out.
  gangFactionPriority: string[];
  // Recruits are named from this list in order (then Member-N) - Greek
  // myth, matching the BN9 gang's hand-picked names.
  memberNames: string[];
  // Equipment costing up to this is bought for everyone, as many items per
  // tick as cash allows (still within reserve/maxSpendFraction; not the
  // shared savings target - see purchaseEquipmentIfAffordable).
  // Regular equipment is lost on ascension (gang augmentations aren't),
  // which is acceptable at this price next to gang income.
  maxEquipmentCost: number;
  // No regular equipment for a member this long after it ascends (it's
  // thrown away at the next ascension; augmentations are still bought).
  equipmentCooldownMinutes: number;
};

export const DEFAULT_CONFIG: GangConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  minWantedPenalty: 0.9,
  wantedReductionFraction: 0.2,
  minAscensionGainMultiplier: 1.1,
  earlyAscensionGainMultiplier: 2,
  // The game's gang member cap.
  fullGangSize: 12,
  trainingReadyMargin: 0.95,
  posture: "CONSOLIDATE",
  territoryWarfareMembers: 2,
  minEarningMembers: 3,
  minClashWinChance: 0.65,
  maxCasualties: 1,
  maxEquipmentCost: 4e9,
  equipmentCooldownMinutes: 20,
  gangFactionPriority: GANG_FACTION_PRIORITY,
  memberNames: [
    "Clotho",
    "Atropos",
    "Lachesis",
    "Achates",
    "Acmon",
    "Creusa",
    "Ascanius",
    "Lapyx",
    "Lares",
    "Mimas",
    "Heracles",
    "Hercules",
    "Castor",
    "Pollux",
    "Theseus",
    "Orion",
  ],
};

export const CONFIG_PATH = "/etc/gang.txt";
const STATE_PATH = "/var/gang_state.txt";
const TICK_INTERVAL_MS = 5000;
const TERRITORY_WARFARE_TASK = "Territory Warfare";

// nodeReset: the BitNode this state belongs to (see stateForNode).
export type GangState = { lastKnownMemberCount: number; casualties: number; nodeReset?: number };
const DEFAULT_STATE: GangState = { lastKnownMemberCount: 0, casualties: 0 };

/** The saved state, reset if it was written in another BitNode (stateForNode). */
export function loadState(ns: NS): GangState {
  const saved = loadJsonConfig(ns, STATE_PATH, DEFAULT_STATE);
  const memberCount = ns.gang.inGang() ? ns.gang.getMemberNames().length : 0;
  const state = stateForNode(saved, readBitNodeInfo(ns)?.lastNodeReset, memberCount);
  if (state !== saved) saveState(ns, state);
  return state;
}

function saveState(ns: NS, state: GangState): void {
  ns.write(STATE_PATH, JSON.stringify(state, null, 2), "w");
}

function parsePosture(posture: GangConfig["posture"]): GangPosture {
  return posture === "GROWING" ? GangPosture.GROWING : GangPosture.CONSOLIDATE;
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
  // Respect until the roster is full (it unlocks recruits), then money.
  const objective = gangObjective(ns.gang.getMemberNames().length);

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
      options,
      gang.isHacking ? "Train Hacking" : "Train Combat",
      objective
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
  standDown: boolean,
  rivalPowers: number[]
): Promise<void> {
  const worstWinChance = worstClashWinChance(gang.power, rivalPowers);
  const strongestRivalPower = Math.max(0, ...rivalPowers);

  let shouldEngage = false;
  if (territoryWarfareCount > 0 && !standDown) {
    shouldEngage = decideTerritoryReadiness(gang.power, rivalPowers, config.minClashWinChance);
    await log.debug(
      `[Gang] territory: worstWinChance=${(worstWinChance * 100).toFixed(1)}% ` +
        `(engage at ${(config.minClashWinChance * 100).toFixed(0)}%) power=${gang.power.toFixed(0)} strongestRival=${strongestRivalPower.toFixed(0)}`
    );
  }

  const status: GangStatusFile = {
    power: gang.power,
    territory: gang.territory,
    worstWinChance,
    strongestRivalPower,
    respect: gang.respect,
    territoryWarfareMembers: territoryWarfareCount,
    engaged: shouldEngage,
    writtenAt: Date.now(),
  };
  ns.write(GANG_STATUS_PATH, JSON.stringify(status), "w");

  if (shouldEngage !== gang.territoryWarfareEngaged) {
    ns.gang.setTerritoryWarfare(shouldEngage);
    await log.info(`[Gang] ${shouldEngage ? "Engaging" : "Disengaging"} territory warfare.`);
  }
}

// When each member last ascended (this run) - see skipRecentlyAscended.
const lastAscended = new Map<string, number>();

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
      candidates.push({
        member: name,
        name: equipName,
        cost: ns.gang.getEquipmentCost(equipName),
        augmentation: ns.gang.getEquipmentType(equipName) === "Augmentation",
      });
    }
  }
  // Members who already qualify for ascension will ascend on a coming tick
  // (one per tick) - no regular equipment for them until then.
  const ascending = new Set(
    memberNames.filter((member) => decideAscension(ns.gang.getAscensionResult(member), config.minAscensionGainMultiplier))
  );
  candidates.splice(0, candidates.length, ...skipEquipmentBeforeAscension(candidates, ascending));
  candidates.splice(0, candidates.length, ...skipRecentlyAscended(candidates, lastAscended, Date.now(), config.equipmentCooldownMinutes * 60_000));

  // Pre-install spend-down (install_handshake.ts): the cash is about to be
  // wiped and the gang keeps its equipment, so spend all of it, as many
  // items per tick as it covers.
  if (isSpendDownActive(readInstallPending(ns), Math.floor(Date.now() / 1000))) {
    let remaining = [...candidates];
    for (let i = 0; i < 500; i++) {
      const pick = decideEquipmentPurchase(ns.getServerMoneyAvailable("home"), 0, 1, remaining);
      if (!pick || !ns.gang.purchaseEquipment(pick.member, pick.name)) break;
      await log.info(`[Gang] Pre-install: purchased ${pick.name} for ${pick.member} ($${pick.cost.toFixed(0)}).`);
      remaining = remaining.filter((c) => !(c.member === pick.member && c.name === pick.name));
    }
    return;
  }

  // Everything affordable up to maxEquipmentCost, cheapest first, as many
  // per tick as fit - one item per 5s tick took ~30 minutes to equip a
  // full gang, and gang income comes from member stats. Each purchase still
  // respects the gang's own reserve and maxSpendFraction, with live cash
  // re-read after every buy - but NOT the shared savings target: equipment
  // raises the gang income that fills the savings, so holding it back made
  // saving slower (BN10: a $5.26T target blocked every purchase).
  const reserve = config.reserveMoney;
  let remaining = [...candidates];
  let bought = 0;
  for (let i = 0; i < 500; i++) {
    const cash = i === 0 ? money : ns.getServerMoneyAvailable("home");
    const pick = decideEquipmentPurchase(cash, reserve, config.maxSpendFraction, remaining, config.maxEquipmentCost);
    if (!pick || !ns.gang.purchaseEquipment(pick.member, pick.name)) break;
    remaining = remaining.filter((c) => !(c.member === pick.member && c.name === pick.name));
    bought++;
    await log.debug(`[Gang] Purchased ${pick.name} for ${pick.member} ($${pick.cost.toFixed(0)}).`);
  }
  if (bought > 0) await log.info(`[Gang] Purchased ${bought} equipment item(s) this tick.`);
}

async function ascendIfWorthwhile(ns: NS, log: Logger, config: GangConfig, memberNames: string[]): Promise<void> {
  const candidates: AscensionCandidate[] = memberNames.map((member) => ({ member, result: ns.gang.getAscensionResult(member) }));

  const chosen = selectBestAscensionCandidate(candidates, config.minAscensionGainMultiplier);
  if (!chosen) return;

  if (ns.gang.ascendMember(chosen)) {
    lastAscended.set(chosen, Date.now());
    await log.info(`[Gang] Ascended ${chosen}.`);
  }
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

/**
 * In Approach.GANG, creates the gang once karma allows (karmaBlocksGang),
 * with the first joined faction in config.gangFactionPriority. createGang
 * refuses when not eligible, so trying each tick is harmless.
 */
async function tryCreateGang(ns: NS, log: Logger, config: GangConfig): Promise<void> {
  const player = ns.getPlayer();
  if (!readPhasePolicy(ns).chaseGangKarma || karmaBlocksGang(player.karma, readBitNodeInfo(ns)?.node)) {
    await log.debug(`[Gang] Not in a gang yet (karma ${player.karma.toFixed(0)}); idling.`);
    return;
  }
  const faction = config.gangFactionPriority.find((name) => (player.factions as string[]).includes(name));
  if (!faction) {
    await log.debug(`[Gang] Karma is enough; waiting to join one of ${config.gangFactionPriority.join(", ")}.`);
    return;
  }
  if (ns.gang.createGang(faction as Parameters<NS["gang"]["createGang"]>[0])) {
    await log.info(`[Gang] Created a gang with ${faction}.`);
  }
}

async function tick(ns: NS, log: Logger, config: GangConfig): Promise<void> {
  if (!ns.gang.inGang()) {
    await tryCreateGang(ns, log, config);
    return;
  }

  const state = loadState(ns);

  // Recruiting needs no formulas, so it happens even before Formulas.exe is
  // owned - a gang founded early in a BitNode would otherwise sit empty
  // until the program shopper can afford it.
  let recruitedThisTick = 0;
  if (ns.gang.canRecruitMember()) {
    const name = nextMemberName(new Set(ns.gang.getMemberNames()), config.memberNames);
    if (ns.gang.recruitMember(name)) {
      recruitedThisTick = 1;
      await log.info(`[Gang] Recruited ${name}.`);
    }
  }

  if (!ns.fileExists("Formulas.exe", "home")) {
    // Keep the member count current, so a recruit made while idling isn't
    // mistaken for anything by detectCasualties later.
    const count = ns.gang.getMemberNames().length;
    if (state.lastKnownMemberCount !== count) {
      state.lastKnownMemberCount = count;
      saveState(ns, state);
    }
    await log.warn("[Gang] Formulas.exe not owned; task scoring needs it. Recruiting only.");
    return;
  }

  const memberNames = ns.gang.getMemberNames();
  // Until the gang is full, only exceptional ascensions (ascensionThreshold);
  // every use below (training, equipment, ascending) sees this bar.
  config = {
    ...config,
    minAscensionGainMultiplier: ascensionThreshold(
      memberNames.length,
      config.fullGangSize,
      config.minAscensionGainMultiplier,
      config.earlyAscensionGainMultiplier
    ),
  };
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
  // getAllGangInformation includes our own gang - once we hold territory it
  // passed the territory filter, and our odds against ourselves (always 50%)
  // became the "worst", flipping warfare off below minClashWinChance.
  const rivalPowers = Object.entries(ns.gang.getAllGangInformation())
    .filter(([name, rival]) => name !== gang.faction && rival.territory > 0)
    .map(([, rival]) => rival.power);
  const territoryWarfareCount = decideTerritoryWarfareAssignment(
    posture,
    standDown,
    memberNames.length,
    config.territoryWarfareMembers,
    rivalPowers.length > 0,
    config.minEarningMembers
  );
  const territoryMembers = memberNames.slice(0, territoryWarfareCount);
  const remainingMembers = memberNames.slice(territoryWarfareCount);

  assignTerritoryWarfare(ns, territoryMembers);
  const trainableRemaining = assignTraining(ns, gang, config, remainingMembers);
  assignTasks(ns, gang, config, trainableRemaining);
  // Ascend before buying: ascension throws regular equipment away, so a
  // same-tick purchase for that member would be wasted.
  await ascendIfWorthwhile(ns, log, config, memberNames);
  await purchaseEquipmentIfAffordable(ns, log, config, memberNames);

  await manageTerritoryEngagement(ns, log, config, gang, territoryWarfareCount, standDown, rivalPowers);

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
  // Off home (boot.ts placed it on a hacked server while home was full -
  // BN9 held it, the one that creates the gang, as karma closed in), each
  // tick works on a copy of home's state files (system/remote_state.ts).
  const remote = isRemote(ns);
  if (remote) await log.info(`[Gang] Running on ${ns.getHostname()}; syncing state with home each tick.`);

  let loggedStartupSnapshot = false;

  while (true) {
    const pulled = remote ? await pullState(ns, deadlineIn(TICK_INTERVAL_MS)) : undefined;
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      if (!loggedStartupSnapshot && ns.gang.inGang()) {
        await logMemberSnapshot(ns, log);
        loggedStartupSnapshot = true;
      }
      await tick(ns, log, config);
    }
    if (pulled) await pushState(ns, pulled, deadlineIn(TICK_INTERVAL_MS));

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
