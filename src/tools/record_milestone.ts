import { NS } from "@ns";
import { readBitNodeInfo } from "system/bitnode_info";
import { appendMilestones, milestone, MILESTONES_PATH, recordedFor } from "system/monitoring/milestones";

/**
 * Records a run milestone by hand, for the current run:
 *
 *   run tools/record_milestone.js <name> <ISO time> [--note <text>]
 *
 * For backfilling stages reached before monitoring recorded them, or for
 * notes like a pause. A name already recorded for this run is skipped.
 */
export async function main(ns: NS): Promise<void> {
  const [name, when] = ns.args.map(String);
  const noteIdx = ns.args.indexOf("--note");
  const note = noteIdx >= 0 ? String(ns.args[noteIdx + 1]) : undefined;
  const at = Date.parse(when ?? "");
  const info = readBitNodeInfo(ns);
  if (!name || !Number.isFinite(at) || !info) {
    ns.tprint("usage: run tools/record_milestone.js <name> <ISO time> [--note <text>] (needs /var/bitnode/current.txt)");
    return;
  }
  const raw = ns.read(MILESTONES_PATH);
  if (recordedFor(raw, info.lastNodeReset).has(name)) {
    ns.tprint(`${name} is already recorded for this run.`);
    return;
  }
  ns.write(MILESTONES_PATH, appendMilestones(raw, [milestone(info.node, info.lastNodeReset, name, at, note)]), "w");
  ns.tprint(`Recorded ${name} at ${new Date(at).toISOString()}.`);
}
