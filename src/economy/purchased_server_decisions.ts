/** A single owned purchased server's current RAM, already queried live via ns.getServerMaxRam - this module never calls `ns` itself. */
export type ServerRamState = { host: string; ram: number };

export type PurchaseDecision = { kind: "buyNew"; ram: number } | { kind: "upgrade"; host: string; ram: number } | { kind: "none" };

/**
 * Full picture of one tick's evaluation, not just the winning decision -
 * lets a caller log *why* nothing happened (which candidate was considered,
 * what it would have cost, against what budget) instead of just that
 * nothing did. `buyNewCandidate`/`upgradeCandidate` are populated whenever
 * that action was considered at all, regardless of whether it was
 * affordable or won - undefined only when it was skipped entirely (buy:
 * atServerLimit; upgrade: nothing owned, or the weakest is already at
 * ramLimit).
 */
export type InvestmentEvaluation = {
  decision: PurchaseDecision;
  budget: number;
  buyNewCandidate?: { ram: number; cost: number };
  upgradeCandidate?: { host: string; ram: number; cost: number };
};

/**
 * Picks the single cheapest affordable action this tick: buying a new
 * server, or upgrading the weakest owned one. Budget is the tighter of two
 * independent limits - an absolute floor (reserveMoney, never touched) and
 * a relative throttle (maxSpendFraction of *current* money) - the same
 * pairing hacknet_decisions.ts's decideNodeInvestment uses.
 *
 * Two candidates, cheapest-affordable wins (deliberately the simplest
 * reasonable v1 heuristic, not a production-per-dollar ROI comparison):
 * - Buy a new server, sized to match the *smallest* currently-owned
 *   server's RAM (keeps the fleet roughly balanced instead of buying
 *   permanently-undersized stragglers late-game), or `startingRamGb` if
 *   nothing's owned yet. Skipped once atServerLimit.
 * - Upgrade the server with the least RAM to double it (clamped to
 *   ramLimit). Skipped if it's already at ramLimit, or if there's nothing
 *   owned yet to upgrade.
 *
 * costOfNew/costOfUpgrade are trivial closures over ns.cloud.getServerCost/
 * getServerUpgradeCost, kept as functions (rather than a precomputed lookup
 * table like hacknet_decisions.ts uses) because the RAM value to price is
 * *computed* here, not enumerated up front by the caller.
 */
export function decideServerInvestment(
  money: number,
  reserveMoney: number,
  maxSpendFraction: number,
  ramLimit: number,
  atServerLimit: boolean,
  startingRamGb: number,
  owned: ServerRamState[],
  costOfNew: (ram: number) => number,
  costOfUpgrade: (host: string, ram: number) => number
): InvestmentEvaluation {
  const budget = Math.max(0, Math.min(money - reserveMoney, money * maxSpendFraction));

  const candidates: { cost: number; decision: PurchaseDecision }[] = [];

  let buyNewCandidate: { ram: number; cost: number } | undefined;
  if (!atServerLimit) {
    const newRam = owned.length > 0 ? Math.min(...owned.map((s) => s.ram)) : startingRamGb;
    const cost = costOfNew(newRam);
    buyNewCandidate = { ram: newRam, cost };
    if (Number.isFinite(cost) && cost >= 0) {
      candidates.push({ cost, decision: { kind: "buyNew", ram: newRam } });
    }
  }

  let upgradeCandidate: { host: string; ram: number; cost: number } | undefined;
  if (owned.length > 0) {
    const weakest = owned.reduce((min, s) => (s.ram < min.ram ? s : min));
    if (weakest.ram < ramLimit) {
      const targetRam = Math.min(weakest.ram * 2, ramLimit);
      const cost = costOfUpgrade(weakest.host, targetRam);
      upgradeCandidate = { host: weakest.host, ram: targetRam, cost };
      if (Number.isFinite(cost) && cost >= 0) {
        candidates.push({ cost, decision: { kind: "upgrade", host: weakest.host, ram: targetRam } });
      }
    }
  }

  const affordable = candidates.filter((c) => c.cost <= budget);
  const decision: PurchaseDecision =
    affordable.length === 0 ? { kind: "none" } : affordable.reduce((cheapest, c) => (c.cost < cheapest.cost ? c : cheapest)).decision;

  return { decision, budget, buyNewCandidate, upgradeCandidate };
}
