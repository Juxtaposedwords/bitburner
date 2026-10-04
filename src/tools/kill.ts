import { NS } from "@ns";
import { readStoppedDaemons, STOPPED_DAEMONS_PATH } from "system/reload_plan";

/**
 * Stops a script on home (every copy, whatever its arguments), and tells
 * the reloader to leave it stopped (STOPPED_DAEMONS_PATH) until it's
 * started again:
 *
 *   run tools/kill.js economy/stock_daemon.js
 */
export async function main(ns: NS): Promise<void> {
  const script = String(ns.args[0] ?? "").replace(/^\//, "");
  if (!script) {
    ns.tprint("usage: run tools/kill.js <script>");
    return;
  }
  const stopped = readStoppedDaemons(ns.read(STOPPED_DAEMONS_PATH));
  if (!stopped.includes(script)) ns.write(STOPPED_DAEMONS_PATH, JSON.stringify([...stopped, script]), "w");
  ns.tprint(ns.scriptKill(script, "home") ? `[Kill] Stopped ${script}.` : `[Kill] ${script} wasn't running.`);
}
