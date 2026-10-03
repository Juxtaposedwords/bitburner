import { NS } from "@ns";

type CrimeName = Parameters<NS["sleeve"]["setToCommitCrime"]>[1];

/**
 * One-shot for bootstrap.js: puts every idle sleeve on a crime, then exits
 * so its RAM goes back to workers. Until home holds the full system (and
 * sleeve_daemon.js), sleeves otherwise sat idle - seven of them, at the
 * start of BN12. Mug: money for the shopper and some karma toward a gang,
 * at success chances low stats can manage. sleeve_daemon.js takes over
 * once the full system runs. A no-op without sleeves (ns.sleeve throws).
 */
const CRIME = "Mug";

export async function main(ns: NS): Promise<void> {
  try {
    for (let i = 0; i < ns.sleeve.getNumSleeves(); i++) {
      if (ns.sleeve.getTask(i) === null) ns.sleeve.setToCommitCrime(i, CRIME as CrimeName);
    }
  } catch {
    // No sleeves in this BitNode.
  }
}
