/**
 * Pure decision logic for gang_daemon.ts - no `ns` dependency, mirrors
 * hacknet_decisions.ts's shape. GangTaskStats has no discrete "task type"
 * field (no money/respect/wanted enum - confirmed by reading
 * NetscriptDefinitions.d.ts in full), so task selection works entirely off
 * per-task moneyGain/wantedLevelGain numbers the daemon precomputes via
 * ns.formulas.gang.* (kept out of this module the same way
 * hacknet_decisions.ts takes a `gainRate` callback rather than importing
 * ns.formulas itself) - never off task name strings.
 *
 * Territory: confirmed against Bitburner's actual source (Gang.ts,
 * formulas/formulas.ts) that 0% territory suppresses money/respect gains
 * by orders of magnitude (territoryMult floors at 0.005 vs. a >1 bonus at
 * high territory), but gang power only ever accrues from members
 * assigned to the "Territory Warfare" task, and accrues unconditionally
 * every cycle regardless of whether ns.gang.setTerritoryWarfare(true) has
 * ever been called - building power and risking real clashes are two
 * separate switches. So GangPosture.GROWING always assigns members to
 * train power risk-free, and only engages real clashes once
 * decideTerritoryReadiness says every rival holding territory is
 * currently a favorable matchup.
 */
import { GangPosture } from "gang/gang";

export type TaskOption = { name: string; moneyGain: number; wantedLevelGain: number; respectGain: number };

export type WantedPolicy = { minWantedPenalty: number; wantedReductionFraction: number };

/**
 * Which task `memberIndex` (of `totalMembers`, a stable ordering e.g. from
 * getMemberNames()) should run this tick. GangGenInfo.wantedPenalty is a
 * multiplier, not a raw penalty magnitude: 1.0 means no penalty at all,
 * dropping toward 0 as wanted level outgrows respect (confirmed against
 * live logs - it moved between 0.979 and 1.000 for a fully-functioning
 * gang, never anywhere near 0). So the trigger is wantedPenalty dropping
 * *below* policy.minWantedPenalty (e.g. 0.9 - "we're losing more than 10%
 * of our gains to wanted level"), not exceeding a max. Once triggered, a
 * fraction of the roster (by index, so the split is stable tick-to-tick)
 * switches to whichever task minimizes wantedLevelGain instead of
 * maximizing moneyGain - simplest reasonable v1, not a joint optimization
 * across the whole roster (same tradeoff already accepted for the
 * Hacknet/purchased-server managers' non-ROI fallback mode).
 */
export function decideMemberTask(
  memberIndex: number,
  totalMembers: number,
  wantedPenalty: number,
  policy: WantedPolicy,
  optionsIn: TaskOption[],
  trainingTask?: string
): string | undefined {
  // Never idle, and never Territory Warfare (assigned separately). A new,
  // weak member earns $0 at everything, and on that tie "Unassigned" (the
  // game's idle state, listed first) won - leaving the member idle.
  const options = optionsIn.filter((o) => !NON_WORK_TASKS.includes(o.name));
  if (options.length === 0) return trainingTask;

  const reservedForWantedControl =
    wantedPenalty < policy.minWantedPenalty ? Math.max(1, Math.round(totalMembers * policy.wantedReductionFraction)) : 0;

  if (memberIndex < reservedForWantedControl) return options.reduce((best, o) => (o.wantedLevelGain < best.wantedLevelGain ? o : best)).name;
  const best = options.reduce((b, o) => (o.moneyGain > b.moneyGain ? o : b));
  // Nothing pays yet: train until the member's stats make crime pay.
  return best.moneyGain > 0 || !trainingTask ? best.name : trainingTask;
}

/** Tasks decideMemberTask never picks: idle, and Territory Warfare (assigned by decideTerritoryWarfareAssignment). */
export const NON_WORK_TASKS = ["Unassigned", "Territory Warfare"];

// `augmentation`: a gang augmentation (ns.gang.getEquipmentType ===
// "Augmentation") - kept through ascension, unlike regular equipment.
export type EquipmentOption = { member: string; name: string; cost: number; augmentation?: boolean };

/**
 * Cheapest affordable equipment not already owned by its member - same
 * cheapest-first shape as decideNodeInvestment's non-ROI fallback.
 * Deliberate scope cut: a true ROI version would need to simulate each
 * equipment's stat-multiplier effect on moneyGain first, but the exact
 * stacking rule for EquipmentStats onto GangMemberInfo's *_mult fields
 * isn't nailed down from the type definitions alone (see gang_daemon.ts's
 * module doc) - this is the same honest "simplest reasonable v1" already
 * used elsewhere, not a guess at the missing mechanic.
 */
export function decideEquipmentPurchase(
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  candidates: EquipmentOption[],
  maxItemCost = Infinity
): EquipmentOption | undefined {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));
  const affordable = candidates.filter((c) => c.cost <= budget && c.cost <= maxItemCost);
  if (affordable.length === 0) return undefined;

  // Gang augmentations first (they survive ascension), then equipment;
  // cheapest first within each.
  const augmentations = affordable.filter((c) => c.augmentation);
  const pool = augmentations.length > 0 ? augmentations : affordable;
  return pool.reduce((best, c) => (c.cost < best.cost ? c : best));
}

/**
 * Leaves out regular equipment for members about to ascend (`ascending`):
 * ascension throws their weapons/armor/vehicles/rootkits away, so buy those
 * after it. Their augmentations stay - those survive ascension.
 */
export function skipEquipmentBeforeAscension(candidates: EquipmentOption[], ascending: Set<string>): EquipmentOption[] {
  return candidates.filter((c) => c.augmentation || !ascending.has(c.member));
}

/**
 * Leaves out regular equipment for members who ascended within
 * `cooldownMs`: a member cycling through ascensions (Hercules, every 2-3
 * minutes in BN12) threw away 21 freshly bought items each time - most of
 * the gang's $176B/hour spend. Augmentations survive ascension, so those
 * are still bought.
 */
export function skipRecentlyAscended(candidates: EquipmentOption[], lastAscended: Map<string, number>, now: number, cooldownMs: number): EquipmentOption[] {
  return candidates.filter((c) => c.augmentation || now - (lastAscended.get(c.member) ?? -Infinity) >= cooldownMs);
}

/**
 * The ascension bar for this tick: `normal` once the gang has all
 * `fullGangSize` members, `early` (much higher) before that. Ascending
 * costs the member's share of gang respect, and new members come from
 * respect - BN10's new gang sat at 10 of 12 with ~177K respect, where
 * routine ascensions would delay the last recruits. An exceptional gain
 * still clears `early`.
 */
export function ascensionThreshold(memberCount: number, fullGangSize: number, normal: number, early: number): number {
  return memberCount >= fullGangSize ? normal : Math.max(normal, early);
}

export type AscensionResult = { hack: number; str: number; def: number; dex: number; agi: number; cha: number };

/**
 * Ascends only if the average multiplier-increase factor across a
 * member's *trained* stats exceeds minGainMultiplier (e.g. 1.1 = at
 * least a 10% average gain) - a simple, tunable threshold rather than a
 * full respect-lost-vs-multiplier-gained optimization.
 *
 * "Trained" deliberately excludes stats sitting at ~1.0 (no change) -
 * a combat-focused member never earns hacking experience, so their `hack`
 * factor from getAscensionResult is always ~1.0 regardless of how good
 * the ascension actually is. Averaging that in with the other five
 * unconditionally drags a genuinely worthwhile ascension below threshold
 * even when every stat the member actually uses shows a strong gain -
 * caught live: the in-game UI showed every member as ascension-ready
 * while this kept returning false for all of them.
 */
export function decideAscension(ascensionResult: AscensionResult | undefined, minGainMultiplier: number): boolean {
  if (!ascensionResult) return false;

  return averageMultiplier(ascensionResult) >= minGainMultiplier;
}

/** Exported so gang_daemon.ts's startup debug snapshot can log the exact number decideAscension is comparing against, rather than a separately-computed one that could drift out of sync. */
export function averageMultiplier(result: AscensionResult): number {
  const trained = [result.hack, result.str, result.def, result.dex, result.agi, result.cha].filter((factor) => factor > 1.001);
  if (trained.length === 0) return 1;

  return trained.reduce((sum, factor) => sum + factor, 0) / trained.length;
}

/**
 * "Train Combat"/"Train Hacking" (see NetscriptDefinitions.d.ts's gang
 * task list, confirmed against Bitburner's own tasks.ts) produce zero
 * money/respect/wanted - every other task dilutes stat exp gain across
 * whatever its money/respect/wanted formulas need, so 100% of a training
 * tick's output goes straight into stat exp instead. Reactive, not a
 * standing reservation: only pulls a member into training once their
 * average trained-stat gain is already within `readyMargin` of
 * minGainMultiplier (e.g. 0.95 * 1.1 = 1.045) - close enough that a
 * training tick or two finishes the job - rather than committing
 * ongoing foregone income for a member who's still far from ascending.
 * isHackingGang picks the one training task that matches what the
 * gang's own tasks actually use (GangGenInfo.isHacking) - same
 * "don't hardcode which stat matters" spirit as decideMemberTask
 * scoring off live formulas rather than task names, though this one
 * unavoidably needs the real task name since ns.gang.setMemberTask
 * takes one and there's no formula-scored way to request "whichever
 * task trains fastest."
 */
export function decideTrainingTask(
  ascensionResult: AscensionResult | undefined,
  minGainMultiplier: number,
  readyMargin: number,
  isHackingGang: boolean
): string | undefined {
  if (!ascensionResult) return undefined;
  if (averageMultiplier(ascensionResult) < minGainMultiplier * readyMargin) return undefined;

  return isHackingGang ? "Train Hacking" : "Train Combat";
}

export type AscensionCandidate = { member: string; result: AscensionResult | undefined };

/**
 * At most one member ascends per tick - ascending costs the gang's whole
 * respect pool (GangMemberAscension.respect: "amount of respect lost from
 * ascending"), so doing every eligible member in the same tick can crash
 * respect almost to zero in one shot (seen live: 357M -> 38.5K after
 * ascending 12 members at once). Same "one decision per tick, re-derive
 * fresh state next tick" pacing already used for equipment/hacknet/
 * purchased-server/faction purchases - picks whichever eligible member
 * has the highest average gain, same tiebreak style as those modules'
 * cheapest-first picks.
 */
export function selectBestAscensionCandidate(candidates: AscensionCandidate[], minGainMultiplier: number): string | undefined {
  const eligible = candidates.filter((c) => decideAscension(c.result, minGainMultiplier));
  if (eligible.length === 0) return undefined;

  return eligible.reduce((best, c) => (averageMultiplier(c.result!) > averageMultiplier(best.result!) ? c : best)).member;
}

/**
 * How many members (by count, carved off the front of the roster before
 * decideMemberTask ever sees the rest) should train power on the
 * "Territory Warfare" task this tick. Zero whenever posture isn't
 * GROWING or the casualty circuit breaker has tripped - see
 * decideStandDown below and gang_daemon.ts's module doc for why
 * standDown overrides posture at runtime without touching the config
 * file the user set it in. Also zero once no rival holds any territory
 * (100% ours): there's nobody left to clash with, so power training would
 * only take members off earning. And always leaves `minEarners` members
 * earning: recruiting needs respect, which warfare doesn't earn - a fresh
 * BN10 gang put all its first recruits on Territory Warfare (the config
 * still asked for last run's late-game count) and stalled at respect 1.
 * Warfare still starts early with the rest: power takes time to build,
 * the last recruits cost the most respect, and territory raises respect
 * gains too.
 */
export function decideTerritoryWarfareAssignment(
  posture: GangPosture,
  standDown: boolean,
  totalMembers: number,
  desiredCount: number,
  rivalsHoldTerritory = true,
  minEarners = 0
): number {
  if (posture !== GangPosture.GROWING || standDown || !rivalsHoldTerritory) return 0;

  return Math.max(0, Math.min(desiredCount, totalMembers - minEarners));
}

/**
 * The next recruit's name: the first of `names` not already in the gang,
 * then `Member-N` (first free N) once the list is used up - a replacement
 * for a fallen member gets their free name back.
 */
export function nextMemberName(existing: Set<string>, names: string[]): string {
  const fromList = names.find((name) => !existing.has(name));
  if (fromList) return fromList;
  let index = existing.size;
  while (existing.has(`Member-${index}`)) index++;
  return `Member-${index}`;
}

/**
 * Karma needed to create a gang outside BitNode 2 (Source-File 2 unlocks
 * gangs elsewhere, behind this). Karma only drops by committing crimes.
 */
export const GANG_KARMA_REQUIREMENT = -54000;

/** Whether karma still blocks creating a gang in `node` (BitNode 2 has no karma requirement). */
export function karmaBlocksGang(karma: number, node: number | undefined): boolean {
  return node !== 2 && karma > GANG_KARMA_REQUIREMENT;
}

/**
 * Written by gang_daemon.ts every tick; monitoring_daemon.ts turns it into
 * gauge/gang_* series. Going through a file keeps ns.gang's RAM cost off
 * the sampler, the same way faction rep reaches it.
 */
export const GANG_STATUS_PATH = "/var/gang_status.txt";
export type GangStatusFile = {
  power: number;
  // Fractions (0-1), as the game reports them.
  territory: number;
  worstWinChance: number;
  strongestRivalPower: number;
  respect: number;
  territoryWarfareMembers: number;
  engaged: boolean;
  writtenAt: number;
};

/** The lowest clash win chance against any of `rivalPowers` (1 with no rivals) - what decideTerritoryReadiness compares to its threshold. */
export function worstClashWinChance(myPower: number, rivalPowers: number[]): number {
  return rivalPowers.reduce((worst, rivalPower) => Math.min(worst, myPower / (myPower + rivalPower)), 1);
}

/**
 * True only if our power favors us against EVERY rival gang currently
 * holding territory (the toughest rival gates readiness, not the
 * average - one bad matchup is enough to lose territory back even while
 * winning against everyone else). Win chance matches
 * ns.gang.getChanceToWinClash's real formula: myPower / (myPower +
 * theirPower) (confirmed against Bitburner's AllGangs.ts). Trivially
 * true if no rival holds any territory - nothing to be unready for.
 */
export function decideTerritoryReadiness(myPower: number, rivalPowers: number[], minClashWinChance: number): boolean {
  return rivalPowers.every((rivalPower) => myPower / (myPower + rivalPower) >= minClashWinChance);
}

/**
 * The gang state to use in the current BitNode. /var/gang_state.txt
 * survives a BitNode change, so BN9's 12-member count met BN10's new, small
 * gang and detectCasualties counted the difference as 12 deaths - tripping
 * the stand-down that disables territory warfare. State belongs to the
 * BitNode it was written in (`nodeReset`, ns.getResetInfo().lastNodeReset);
 * from any other one - or with none recorded - it starts fresh at the
 * current member count. An unknown current node keeps the state as is.
 */
export function stateForNode<T extends { lastKnownMemberCount: number; casualties: number; nodeReset?: number }>(
  state: T,
  currentNodeReset: number | undefined,
  currentMemberCount: number
): T {
  if (currentNodeReset === undefined || state.nodeReset === currentNodeReset) return state;
  return { ...state, lastKnownMemberCount: currentMemberCount, casualties: 0, nodeReset: currentNodeReset };
}

/**
 * How many members died since last tick, accounting for a recruit
 * landing the same tick as a death so one doesn't mask the other in the
 * raw member-count delta (recruiting only ever increases the count, so
 * any shortfall beyond what recruiting explains is a death).
 */
export function detectCasualties(previousMemberCount: number, currentMemberCount: number, recruitedThisTick: number): number {
  return Math.max(0, previousMemberCount + recruitedThisTick - currentMemberCount);
}

/**
 * Once tripped, nothing in this module auto-clears it - gang_daemon.ts
 * requires the user to explicitly edit /var/gang_state.txt's casualties
 * back down (or delete the file) to try again. A member death is
 * permanent; silently auto-retrying past one isn't a decision this
 * codebase makes on the user's behalf (same principle as
 * autoInstall/autoPurchaseAugmentations defaulting off in faction_daemon.ts).
 */
export function decideStandDown(casualties: number, maxCasualties: number): boolean {
  return casualties >= maxCasualties;
}
