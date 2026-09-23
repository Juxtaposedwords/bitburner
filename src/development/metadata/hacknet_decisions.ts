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
 * provided (still considered normally in the no-gainRate fallback). Known
 * scope-cut: this means hash-storage overflow isn't guarded against here -
 * acceptable given hashes get spent every tick whenever anything's
 * affordable (see hacknet_daemon.ts's hash-spend section), but worth
 * revisiting if overflow turns out to be a real problem in practice.
 */
export function decideNodeInvestment(
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  purchaseNodeCost: number,
  atMaxNodes: boolean,
  nodes: NodeUpgradeCosts[],
  gainRate?: (level: number, ram: number, cores: number) => number
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

  const affordable = candidates.filter((c) => c.cost <= budget);
  const isBetter = (a: Candidate, b: Candidate): boolean => (gainRate ? a.score > b.score : a.score < b.score);
  const pickBest = (list: Candidate[]): Candidate => list.reduce((best, c) => (isBetter(c, best) ? c : best));

  const decision: PurchaseDecision = affordable.length === 0 ? { kind: "none" } : pickBest(affordable).decision;
  const best = candidates.length > 0 ? pickBest(candidates) : undefined;

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
