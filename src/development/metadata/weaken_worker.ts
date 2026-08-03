import { NS } from "@ns";

/** See hack_worker.ts for why this is a separate, minimal script. */
export async function main(ns: NS): Promise<void> {
  const target = ns.args[0] as string;
  const additionalMsec = ns.args[1] as number;

  await ns.weaken(target, { additionalMsec });
}
