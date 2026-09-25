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
import { GangPosture } from "development/metadata/gang";

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
  options: TaskOption[]
): string | undefined {
  if (options.length === 0) return undefined;

  const reservedForWantedControl =
    wantedPenalty < policy.minWantedPenalty ? Math.max(1, Math.round(totalMembers * policy.wantedReductionFraction)) : 0;

  return memberIndex < reservedForWantedControl
    ? options.reduce((best, o) => (o.wantedLevelGain < best.wantedLevelGain ? o : best)).name
    : options.reduce((best, o) => (o.moneyGain > best.moneyGain ? o : best)).name;
}

export type EquipmentOption = { member: string; name: string; cost: number };

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
  candidates: EquipmentOption[]
): EquipmentOption | undefined {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));
  const affordable = candidates.filter((c) => c.cost <= budget);
  if (affordable.length === 0) return undefined;

  return affordable.reduce((best, c) => (c.cost < best.cost ? c : best));
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
 * file the user set it in.
 */
export function decideTerritoryWarfareAssignment(
  posture: GangPosture,
  standDown: boolean,
  totalMembers: number,
  desiredCount: number
): number {
  if (posture !== GangPosture.GROWING || standDown) return 0;

  return Math.min(desiredCount, totalMembers);
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
