import { NS } from "@ns";

/**
 * bootstrap.ts's worker: the classic self-balancing early-game loop against
 * one target - weaken while security is well above minimum, grow while money
 * is well below maximum, otherwise hack. No batching or RPC, so it costs
 * about 2.4 GB per thread and needs nothing else running. args: target,
 * then a tag that only makes each exec's arguments unique (the game refuses
 * a second copy with identical arguments on the same host).
 */
export async function main(ns: NS): Promise<void> {
  const target = ns.args[0] as string;
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const maxMoney = ns.getServerMaxMoney(target);

  while (true) {
    if (ns.getServerSecurityLevel(target) > minSecurity + 5) await ns.weaken(target);
    else if (ns.getServerMoneyAvailable(target) < maxMoney * 0.75) await ns.grow(target);
    else await ns.hack(target);
  }
}
