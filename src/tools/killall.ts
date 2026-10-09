import { NS } from "@ns";
import { daemonHosts } from "system/remote_state";

/**
 * Stops every script on home and on every daemon host - unlike the
 * terminal's `killall`, which only reaches the server you're on, so daemons
 * placed elsewhere (faction services, gang and sleeve daemons) survived it:
 *
 *   run tools/killall.js
 *
 * Then `run boot.js` starts everything again. Workers on other servers are
 * left alone (the scheduler or bootstrap redeploys them anyway).
 */
export async function main(ns: NS): Promise<void> {
  const self = ns.pid;
  const hosts = daemonHosts(ns);
  for (const host of hosts) ns.killall(host);
  for (const p of ns.ps("home")) if (p.pid !== self) ns.kill(p.pid);
  ns.tprint(`[KillAll] Stopped everything on home and ${hosts.length} daemon host(s): ${hosts.join(", ") || "none"}. Run boot.js to start again.`);
}
