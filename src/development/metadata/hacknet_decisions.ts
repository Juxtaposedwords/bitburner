/**
 * Current stats and upgrade costs for one owned Hacknet Node/Server,
 * already queried live via ns.hacknet.getNodeStats/get{Level,Ram,Core,
 * Cache}UpgradeCost - this module never calls `ns` itself. cacheCost is
 * omitted entirely for a plain Hacknet Node (upgradeCache/
 * getCacheUpgradeCost are Server-only), rather than passed as Infinity, so
 * a caller can't accidentally treat "not applicable" as "just very
 * expensive."
 */
export type NodeUpgradeCosts = {
  index: number;
  level: number;
  ram: number;
  cores: number;
  levelCost: number;
  ramCost: number;
  coreCost: number;
  cacheCost?: number;
};

export type PurchaseDecision =
  | { kind: "buyNode" }
  | { kind: "upgrade"; index: number; upgrade: "level" | "ram" | "core" | "cache" }
  | { kind: "none" };

/** See decideNodeInvestment's `maxPayback`. */
export type MaxPayback = { seconds: number; valuePerUnit: number };

/**
 * Full picture of one tick's evaluation, not just the winning decision -
 * lets a caller log *why* nothing happened. Rather than surfacing every
 * candidate considered (could be dozens with enough nodes owned),
 * `bestCandidate` is the single best-scoring one found, whether or not it
 * was actually affordable - enough to diagnose a stuck tick without
 * spamming the log. "Best" means cheapest in the no-`gainRate` fallback,
 * or highest production-per-dollar when `gainRate` is provided (see
 * decideNodeInvestment).
 */
export type InvestmentEvaluation = {
  decision: PurchaseDecision;
  budget: number;
  bestCandidate?: { cost: number; decision: PurchaseDecision };
  candidateCount: number;
};

/**
 * Picks the single best action this tick: buying a new node, or upgrading
 * one axis of an existing one. Budget is the tighter of two independent
 * limits - an absolute floor (reserveMoney, never touched) and a relative
 * throttle (maxSpendFraction of *current* money, so one tick can't commit
 * everything at once even before the floor is reached) - mirroring
 * scheduler_daemon.ts's homeReservedRamGb/homeFallbackHackingLevel pairing.
 *
 * `gainRate` (optional) is the actual formula for what a node's production
 * would be at a given (level, ram, cores) - ns.formulas.hacknetServers.
 * hashGainRate or ns.formulas.hacknetNodes.moneyGainRate, wired in by
 * hacknet_daemon.ts only when Formulas.exe is owned. When provided, every
 * candidate is scored by (productionAfter - productionBefore) / cost - true
 * ROI - and the highest-scoring affordable candidate wins, not the
 * cheapest. When omitted, falls back to the original cheapest-affordable-
 * wins heuristic exactly as before - this is a strictly additive change,
 * not a rewrite.
 *
 * ramUsed is treated as 0 in every gainRate call, even though the real
 * hashGainRate formula takes it (a Hacknet Server's live ramUsed
 * fluctuates as scheduler_daemon.ts places HWGW workers on it). This is a
 * deliberate simplification: the goal is *relative* ranking between
 * level/ram/core upgrades, not predicting exact absolute output, and
 * holding ramUsed constant across every before/after comparison keeps the
 * ranking valid for that purpose - it also lets one 3-argument closure
 * signature serve both hashGainRate and moneyGainRate (which doesn't take
 * ramUsed at all).
 *
 * Cache upgrades are excluded entirely from ROI-mode scoring - cache only
 * grows hash storage capacity, it doesn't affect production rate at all,
 * so it would always score 0 ROI and never win on merit. Rather than fake
 * a score, it's just left out of the competition when gainRate is
 * provided (still considered normally in the no-gainRate fallback).
 *
 * `maxPayback` (ROI mode only) skips any candidate that wouldn't earn its
 * cost back within `seconds`, valuing one unit of production at
 * `valuePerUnit` dollars. An install wipes the whole Hacknet, so an upgrade
 * that pays back after the next install never pays back at all; and
 * because each upgrade costs more than the last, this is also what stops
 * spending once the fleet is built out, instead of maxSpendFraction alone.
 *
 * `needCapacity` covers what ROI can't see: hash upgrade costs rise with
 * every level bought, and one costing more than the hashes you can store
 * can never be bought at all. When the caller sets it (see
 * hacknet_daemon.ts's capacityBound check), the cheapest affordable cache
 * upgrade wins outright; if none is affordable, the normal pick applies.
 */
export function decideNodeInvestment(
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  purchaseNodeCost: number,
  atMaxNodes: boolean,
  nodes: NodeUpgradeCosts[],
  gainRate?: (level: number, ram: number, cores: number) => number,
  needCapacity = false,
  maxPayback?: MaxPayback,
  maxItemCost = Infinity
): InvestmentEvaluation {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction, maxItemCost));

  type Candidate = { cost: number; decision: PurchaseDecision; score: number };
  const candidates: Candidate[] = [];
  const scoreOf = (cost: number, deltaProduction: number): number => (gainRate ? deltaProduction / cost : cost);

  if (!atMaxNodes && Number.isFinite(purchaseNodeCost)) {
    const deltaProduction = gainRate ? gainRate(1, 1, 1) : 0;
    candidates.push({ cost: purchaseNodeCost, decision: { kind: "buyNode" }, score: scoreOf(purchaseNodeCost, deltaProduction) });
  }

  for (const node of nodes) {
    const before = gainRate ? gainRate(node.level, node.ram, node.cores) : 0;

    const upgrades: { upgrade: "level" | "ram" | "core"; cost: number; after: number }[] = [
      { upgrade: "level", cost: node.levelCost, after: gainRate ? gainRate(node.level + 1, node.ram, node.cores) : 0 },
      { upgrade: "ram", cost: node.ramCost, after: gainRate ? gainRate(node.level, node.ram * 2, node.cores) : 0 },
      { upgrade: "core", cost: node.coreCost, after: gainRate ? gainRate(node.level, node.ram, node.cores + 1) : 0 },
    ];
    for (const { upgrade, cost, after } of upgrades) {
      if (!Number.isFinite(cost)) continue;
      candidates.push({ cost, decision: { kind: "upgrade", index: node.index, upgrade }, score: scoreOf(cost, after - before) });
    }

    if (!gainRate && node.cacheCost !== undefined && Number.isFinite(node.cacheCost)) {
      candidates.push({ cost: node.cacheCost, decision: { kind: "upgrade", index: node.index, upgrade: "cache" }, score: node.cacheCost });
    }
  }

  // score is production gained per dollar, so payback = 1 / (score * value).
  const paysBack = (c: Candidate): boolean => !gainRate || !maxPayback || c.score * maxPayback.valuePerUnit * maxPayback.seconds >= 1;
  const affordable = candidates.filter((c) => c.cost <= budget && paysBack(c));
  const isBetter = (a: Candidate, b: Candidate): boolean => (gainRate ? a.score > b.score : a.score < b.score);
  const pickBest = (list: Candidate[]): Candidate => list.reduce((best, c) => (isBetter(c, best) ? c : best));

  const best = candidates.length > 0 ? pickBest(candidates) : undefined;

  if (needCapacity) {
    const caches = nodes
      .filter((node) => node.cacheCost !== undefined && Number.isFinite(node.cacheCost) && node.cacheCost <= budget)
      .sort((a, b) => (a.cacheCost as number) - (b.cacheCost as number));
    if (caches.length > 0) {
      return {
        decision: { kind: "upgrade", index: caches[0].index, upgrade: "cache" },
        budget,
        bestCandidate: best ? { cost: best.cost, decision: best.decision } : undefined,
        candidateCount: candidates.length,
      };
    }
  }

  const decision: PurchaseDecision = affordable.length === 0 ? { kind: "none" } : pickBest(affordable).decision;

  return {
    decision,
    budget,
    bestCandidate: best ? { cost: best.cost, decision: best.decision } : undefined,
    candidateCount: candidates.length,
  };
}

/**
 * How node purchases are limited this tick:
 * - `none` while AUGMENTS' install loop runs (installLoopActive): an install
 *   is minutes away and wipes the Hacknet.
 * - `income` otherwise, with income known: anything costing at most
 *   `budgetMinutes` of income, and at most `incomeShare` of income in total
 *   (`tickBudget` per tick of `tickMinutes`). Hashes buy gym/study speed
 *   and target upgrades, worth far more than the money they'd sell for -
 *   with gang income in the trillions a money payback test (BN10 halves
 *   Hacknet money too) kept the Hacknet tiny. The total cap matters: with
 *   only the per-item cap, BN10 spent $1,917T/min on it - 75x the gang's
 *   income - for 164 hashes/s.
 * - `payback` without income data (or budgetMinutes 0): the old
 *   maxPaybackHours test.
 */
// Without income data: at most this share of cash per item, and per tick.
const NO_INCOME_ITEM_SHARE = 0.25;
const NO_INCOME_TICK_SHARE = 0.02;

export type NodePolicy = { kind: "none" } | { kind: "income"; maxItemCost: number; tickBudget: number } | { kind: "payback" };

export function nodePolicy(
  installLoop: boolean,
  incomePerMin: number | undefined,
  budgetMinutes: number,
  incomeShare = 0.05,
  tickMinutes = 5 / 60,
  cash?: number
): NodePolicy {
  if (installLoop) return { kind: "none" };
  if (!(budgetMinutes > 0)) return { kind: "payback" };
  // No income data (monitoring not running yet, e.g. a fresh BitNode's
  // small home): a small share of cash instead. The payback test valued
  // hashes at Sell for Money and bought nothing - BN12 had 7 sleeves at the
  // gym and no Hacknet server.
  if ((incomePerMin === undefined || !(incomePerMin > 0)) && cash !== undefined && cash > 0) {
    return { kind: "income", maxItemCost: cash * NO_INCOME_ITEM_SHARE, tickBudget: cash * NO_INCOME_TICK_SHARE };
  }
  if (incomePerMin === undefined || !(incomePerMin > 0)) return { kind: "payback" };
  return { kind: "income", maxItemCost: incomePerMin * budgetMinutes, tickBudget: incomePerMin * incomeShare * tickMinutes };
}


/** Written by hacknet_daemon.ts every tick, for tools/status.js. */
export const HACKNET_STATUS_PATH = "/var/hacknet_status.txt";
export type HacknetStatusFile = {
  nodes: number;
  maxNodes: number;
  // Hacknet Servers (hashes) rather than Nodes (money).
  servers: boolean;
  // Hashes/s for servers, $/s for nodes.
  productionPerSec: number;
  hashes: number;
  hashCapacity: number;
  policy: NodePolicy["kind"];
  hashSpending: string;
  writtenAt: number;
};

export const IMPROVE_STUDYING = "Improve Studying";
export const IMPROVE_GYM = "Improve Gym Training";
export const COMPANY_FAVOR = "Company Favor";
export const REDUCE_MIN_SECURITY = "Reduce Minimum Security";
export const INCREASE_MAX_MONEY = "Increase Maximum Money";
export const SELL_FOR_MONEY = "Sell for Money";

export type HashChoiceInputs = {
  numHashes: number;
  capacity: number;
  // Live hashCost per upgrade name (missing = not available).
  costs: Record<string, number>;
  // Someone (player or sleeve) is training a stat a goal is blocked on.
  gymForGoal: boolean;
  classForGoal: boolean;
  // Company whose favor sleeves are working toward an invite, if any.
  companyTarget?: string;
  // The scheduler's top-earning target (topEarner), if any.
  topEarner?: { host: string; chance: number };
  // Sell only past this fraction of capacity.
  sellAboveFraction: number;
};

export type HashChoice = { upgrade: string; target?: string; reason: string };

/**
 * The hash upgrade worth buying next - the first that applies, in order:
 * 1. Improve Gym Training / Improve Studying, only while a goal is blocked
 *    on that stat and someone trains it.
 * 2. Company Favor, while sleeves work toward a corporate invite.
 * 3. Reduce Minimum Security on the top earner, only while its hack chance
 *    is under 95% (it only speeds batches up otherwise).
 * 4. Increase Maximum Money on the top earner: +2% of its max money, which
 *    caps what each batch takes.
 * 5. Sell for Money near capacity, when nothing else applies.
 * `wanted` is the first applicable step even when it isn't affordable yet:
 * hashes are saved for it (not spent lower down), and the caller adds
 * cache when it costs more than capacity can hold. All of these upgrades
 * and hashes themselves reset at an install, so nothing is ever held back
 * for later beyond that.
 */
export function chooseHashUpgrade(inputs: HashChoiceInputs): { buy?: HashChoice; wanted?: HashChoice } {
  const steps: HashChoice[] = [];
  if (inputs.gymForGoal) steps.push({ upgrade: IMPROVE_GYM, reason: "a goal waits on combat stats being trained" });
  if (inputs.classForGoal) steps.push({ upgrade: IMPROVE_STUDYING, reason: "a goal waits on hacking being studied" });
  if (inputs.companyTarget) steps.push({ upgrade: COMPANY_FAVOR, target: inputs.companyTarget, reason: "sleeves work toward a corporate invite" });
  if (inputs.topEarner && inputs.topEarner.chance < 0.95) {
    steps.push({ upgrade: REDUCE_MIN_SECURITY, target: inputs.topEarner.host, reason: `top earner's hack chance is ${(inputs.topEarner.chance * 100).toFixed(0)}%` });
  }
  if (inputs.topEarner) steps.push({ upgrade: INCREASE_MAX_MONEY, target: inputs.topEarner.host, reason: "top earner's max money caps each batch" });

  const wanted = steps.find((step) => inputs.costs[step.upgrade] !== undefined);
  if (wanted && inputs.costs[wanted.upgrade] <= inputs.numHashes) return { buy: wanted, wanted };
  const sellCost = inputs.costs[SELL_FOR_MONEY];
  if (inputs.capacity > 0 && inputs.numHashes >= inputs.sellAboveFraction * inputs.capacity && sellCost !== undefined && sellCost <= inputs.numHashes) {
    return { buy: { upgrade: SELL_FOR_MONEY, reason: "near capacity, saving for something that costs more" }, wanted };
  }
  return { wanted };
}
