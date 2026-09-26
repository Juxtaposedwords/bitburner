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
  maxPayback?: MaxPayback
): InvestmentEvaluation {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));

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
 * First name in `priority` (most-preferred-first) that's both a known and
 * currently affordable upgrade. Unknown names (typo'd in /etc/hacknet.txt)
 * or ones costing more than numHashes are skipped rather than treated as
 * an error - a bad entry just falls through to the next preference.
 */
export function pickHashUpgrade(priority: string[], numHashes: number, costs: Record<string, number>): string | undefined {
  return priority.find((name) => costs[name] !== undefined && costs[name] <= numHashes);
}

/**
 * True when every recognized priority upgrade costs more than the hashes
 * that can build up before the drain starts selling (drainAboveFraction of
 * capacity) - i.e. nothing on the list can ever be bought again without
 * more hash capacity. Names missing from `costs` are ignored; an empty list
 * never needs capacity.
 */
export function hashCapacityBound(priority: string[], costs: Record<string, number>, capacity: number, drainAboveFraction: number): boolean {
  const known = priority.map((name) => costs[name]).filter((cost): cost is number => cost !== undefined);
  return known.length > 0 && Math.min(...known) > drainAboveFraction * capacity;
}

/** The hash upgrade that speeds up each training activity (see study_decisions.ts's ActivityFile). */
export const ACTIVITY_HASH_UPGRADE: Record<string, string> = {
  class: "Improve Studying",
  gym: "Improve Gym Training",
};

/**
 * `priority` with the upgrade boosting the player's current activity moved
 * to the front - hashes spent on Improve Studying while at the gym (or the
 * reverse) do nothing until the activity changes. Only reorders: an upgrade
 * not already on the list isn't added, and anything else ("none", unknown)
 * leaves the list as configured.
 */
export function prioritizeForActivity(priority: string[], activity: string | undefined): string[] {
  const upgrade = activity === undefined ? undefined : ACTIVITY_HASH_UPGRADE[activity];
  if (!upgrade || !priority.includes(upgrade)) return priority;
  return [upgrade, ...priority.filter((name) => name !== upgrade)];
}

/**
 * One hash purchase: the first affordable upgrade in `priority`, or - only
 * once hashes pass `drainAboveFraction` of capacity - the drain upgrade
 * (normally "Sell for Money"). Hashes past capacity are simply lost, so the
 * drain stops that waste; keeping it off the regular priority list lets
 * hashes build up for the priority upgrades, whose cost rises every level,
 * instead of being sold off every tick. The drain is filtered out of
 * `priority` even if listed there, for the same reason. Callers loop until
 * this returns undefined, re-querying costs after each purchase.
 */
export function decideHashSpend(
  priority: string[],
  numHashes: number,
  capacity: number,
  costs: Record<string, number>,
  drainUpgrade: string,
  drainAboveFraction: number
): { upgrade: string; reason: "priority" | "drain" } | undefined {
  const pick = pickHashUpgrade(
    priority.filter((name) => name !== drainUpgrade),
    numHashes,
    costs
  );
  if (pick) return { upgrade: pick, reason: "priority" };

  const drainCost = costs[drainUpgrade];
  const overThreshold = capacity > 0 && numHashes >= drainAboveFraction * capacity;
  if (overThreshold && drainCost !== undefined && drainCost <= numHashes) return { upgrade: drainUpgrade, reason: "drain" };
  return undefined;
}
