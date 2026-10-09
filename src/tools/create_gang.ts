import { NS } from "@ns";
import { gangFactionFor, GANG_FACTION_PRIORITY } from "gang/gang_decisions";

/**
 * Creates the gang now, with the first joined faction in the gang
 * priority list - when karma allows but gang_daemon.js (32 GB) can't run
 * yet (BN9: no server to place it on after an install):
 *
 *   run tools/create_gang.js [--out /var/claude_out/create_gang.txt]
 *
 * gang_daemon.js manages members once it runs.
 */
export async function main(ns: NS): Promise<void> {
  const out = ns.args.indexOf("--out") >= 0 ? String(ns.args[ns.args.indexOf("--out") + 1]) : undefined;
  const say = (line: string): void => (out ? ns.write(out, `[${new Date().toISOString()}] ${line}\n`, "a") : ns.tprint(line));
  if (ns.gang.inGang()) return say("Already in a gang.");
  const faction = gangFactionFor(undefined, ns.getPlayer().factions, GANG_FACTION_PRIORITY);
  if (!faction) return say(`No gang faction joined yet (${GANG_FACTION_PRIORITY.join(", ")}).`);
  const created = ns.gang.createGang(faction as Parameters<NS["gang"]["createGang"]>[0]);
  say(created ? `Created a gang with ${faction}.` : `Couldn't create a gang with ${faction} (karma not there yet?).`);
}
