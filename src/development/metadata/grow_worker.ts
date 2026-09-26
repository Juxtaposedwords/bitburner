import { NS } from "@ns";

/** See hack_worker.ts for why this is a separate, minimal script, and for the `stock` flag's reasoning. */
export async function main(ns: NS): Promise<void> {
  const target = ns.args[0] as string;
  const additionalMsec = ns.args[1] as number;
  const stock = ns.args[2] as boolean;

  await ns.grow(target, { additionalMsec, stock });
}
