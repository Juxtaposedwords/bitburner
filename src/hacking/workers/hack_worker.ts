import { NS } from "@ns";

/**
 * Minimal by design: kept separate from grow_worker.ts/weaken_worker.ts
 * rather than one combined worker with an action switch, because
 * Bitburner's RAM cost is static per script — a combined script would
 * reference (and pay for) all three of ns.hack/grow/weaken regardless of
 * which branch actually runs, and that delta multiplies by thread count.
 *
 * target, additionalMsec, and stock are passed by scheduler_daemon.ts via
 * ns.args so this script itself needs no RPC/analysis calls at all.
 * `stock: true` is always passed (see scheduler_daemon.ts) - confirmed via
 * Bitburner's own source (StockMarket/PlayerInfluencing.ts) that this
 * flag only has any effect when `target`'s organization matches a real
 * stock, so it's harmless to pass unconditionally against a non-linked
 * target.
 */
export async function main(ns: NS): Promise<void> {
  const target = ns.args[0] as string;
  const additionalMsec = ns.args[1] as number;
  const stock = ns.args[2] as boolean;

  await ns.hack(target, { additionalMsec, stock });
}
