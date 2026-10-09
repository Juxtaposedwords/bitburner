import { NS } from "@ns";
import { readStoppedDaemons, STOPPED_DAEMONS_PATH } from "system/reload_plan";
import { daemonHosts } from "system/remote_state";

/**
 * Stops a script on home and every daemon host (every copy, whatever its
 * arguments), and tells the reloader and boot to leave it stopped
 * (STOPPED_DAEMONS_PATH) until it's started again - or `--undo`, which
 * only clears that, so boot places it again on its next run:
 *
 *   run tools/kill.js economy/stock_daemon.js
 *   run tools/kill.js sleeves/sleeve_daemon.js --undo
 */
export async function main(ns: NS): Promise<void> {
  const script = String(ns.args[0] ?? "").replace(/^\//, "");
  if (!script) {
    ns.tprint("usage: run tools/kill.js <script> [--undo]");
    return;
  }
  const stopped = readStoppedDaemons(ns.read(STOPPED_DAEMONS_PATH));
  if (ns.args.includes("--undo")) {
    ns.write(STOPPED_DAEMONS_PATH, JSON.stringify(stopped.filter((s) => s !== script)), "w");
    ns.tprint(`[Kill] ${script} may run again; boot starts it on its next run.`);
    return;
  }
  if (!stopped.includes(script)) ns.write(STOPPED_DAEMONS_PATH, JSON.stringify([...stopped, script]), "w");
  const killedOn = ["home", ...daemonHosts(ns)].filter((host) => ns.scriptKill(script, host));
  ns.tprint(killedOn.length > 0 ? `[Kill] Stopped ${script} on ${killedOn.join(", ")}.` : `[Kill] ${script} wasn't running.`);
}
