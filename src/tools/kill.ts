import { NS } from "@ns";

/**
 * Stops a script on home (every copy, whatever its arguments):
 *
 *   run tools/kill.js development/metadata/stock_daemon.js
 *
 * The queued-command channel's way to free RAM or stop a daemon.
 */
export async function main(ns: NS): Promise<void> {
  const script = String(ns.args[0] ?? "");
  if (!script) {
    ns.tprint("usage: run tools/kill.js <script>");
    return;
  }
  ns.tprint(ns.scriptKill(script, "home") ? `[Kill] Stopped ${script}.` : `[Kill] ${script} wasn't running.`);
}
