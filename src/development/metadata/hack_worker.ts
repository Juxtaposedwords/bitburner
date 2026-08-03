import { NS } from "@ns";

/**
 * Minimal by design: kept separate from grow_worker.ts/weaken_worker.ts
 * rather than one combined worker with an action switch, because
 * Bitburner's RAM cost is static per script — a combined script would
 * reference (and pay for) all three of ns.hack/grow/weaken regardless of
 * which branch actually runs, and that delta multiplies by thread count.
 *
 * target and additionalMsec are passed by scheduler.ts via ns.args so this
 * script itself needs no RPC/analysis calls at all.
 */
export async function main(ns: NS): Promise<void> {
  const target = ns.args[0] as string;
  const additionalMsec = ns.args[1] as number;

  await ns.hack(target, { additionalMsec });
}
