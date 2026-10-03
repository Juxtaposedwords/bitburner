import { NS } from "@ns";

type FactionNameType = Parameters<NS["sleeve"]["setToFactionWork"]>[1];
type FactionWorkTypeType = Parameters<NS["sleeve"]["setToFactionWork"]>[2];

/**
 * One-shot check of whether a sleeve may work the faction the player is
 * working for:
 *
 *   run tools/sleeve_probe.js [sleeve index, default 0]
 *
 * Tries each work type on the player's current faction and prints what
 * the game says, plus the player's work before and after (in case the
 * game moves the player off instead). sleeve_daemon.ts reassigns the
 * sleeve on its next tick either way.
 */
export async function main(ns: NS): Promise<void> {
  const index = Number(ns.args[0] ?? 0);
  const before = ns.singularity.getCurrentWork();
  if (before?.type !== "FACTION") {
    ns.tprint(`The player isn't doing faction work (current: ${before?.type ?? "nothing"}); start some first.`);
    return;
  }
  const faction = before.factionName;
  ns.tprint(`Player: ${before.factionWorkType} for ${faction}. Trying sleeve ${index} on the same faction...`);

  for (const type of ["hacking", "field", "security"]) {
    try {
      const ok = ns.sleeve.setToFactionWork(index, faction as FactionNameType, type as FactionWorkTypeType);
      ns.tprint(`  ${type}: returned ${ok}`);
      if (ok) break;
    } catch (error) {
      ns.tprint(`  ${type}: threw ${String(error).split("\n")[0]}`);
    }
  }

  const after = ns.singularity.getCurrentWork();
  const task = ns.sleeve.getTask(index);
  ns.tprint(`Sleeve ${index} task now: ${JSON.stringify(task)}`);
  ns.tprint(`Player work now: ${after?.type === "FACTION" ? `${after.factionWorkType} for ${after.factionName}` : (after?.type ?? "nothing")}`);
}
