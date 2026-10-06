import { NS } from "@ns";
import { DAEMON_HOST } from "system/remote_state";
import { scriptClosure } from "system/reload_plan";

/**
 * Runs a daemon on DAEMON_HOST - a purchased server kept for daemons that
 * don't fit on a small home yet (a fresh BitNode starts at 32 GB; the
 * faction daemon alone is ~100 GB). The daemon then keeps its state in
 * step with home through system/remote_state.ts.
 */

/** RAM to buy for a daemon needing `ram`: the next power of two with some headroom. */
export function daemonHostSize(ram: number, headroomGb = 8): number {
  let size = 8;
  while (size < ram + headroomGb) size *= 2;
  return size;
}

/**
 * Starts `script` on DAEMON_HOST, buying or upgrading the server when cash
 * allows; true if it's running there afterwards. `log` reports why not.
 */
export function placeOnDaemonHost(ns: NS, script: string, log: (line: string) => void): boolean {
  if (ns.serverExists(DAEMON_HOST) && ns.isRunning(script, DAEMON_HOST)) return true;
  const ram = ns.getScriptRam(script, "home");
  if (!(ram > 0)) {
    log(`${script} can't be loaded (RAM 0); not placing it.`);
    return false;
  }
  const size = daemonHostSize(ram);
  const cash = ns.getServerMoneyAvailable("home");
  if (!ns.serverExists(DAEMON_HOST)) {
    if (ns.cloud.getServerNames().length >= ns.cloud.getServerLimit()) {
      log(`No room for ${DAEMON_HOST} (purchased server limit reached).`);
      return false;
    }
    const cost = ns.cloud.getServerCost(size);
    if (cost > cash) {
      log(`${DAEMON_HOST} (${size} GB) costs $${(cost / 1e6).toFixed(1)}M; have $${(cash / 1e6).toFixed(1)}M.`);
      return false;
    }
    if (!ns.cloud.purchaseServer(DAEMON_HOST, size)) {
      log(`Couldn't buy ${DAEMON_HOST} (${size} GB).`);
      return false;
    }
    log(`Bought ${DAEMON_HOST} (${size} GB) for daemons that don't fit on home yet.`);
  }
  const free = ns.getServerMaxRam(DAEMON_HOST) - ns.getServerUsedRam(DAEMON_HOST);
  if (free < ram) {
    const target = daemonHostSize(ns.getServerUsedRam(DAEMON_HOST) + ram);
    if (!ns.cloud.upgradeServer(DAEMON_HOST, target)) {
      log(`${DAEMON_HOST} has ${free.toFixed(1)} GB free, ${script} needs ${ram.toFixed(1)}; couldn't upgrade it to ${target} GB.`);
      return false;
    }
  }
  if (!ns.scp(scriptClosure(ns, script), DAEMON_HOST, "home")) {
    log(`Couldn't copy ${script} and its imports to ${DAEMON_HOST}.`);
    return false;
  }
  const pid = ns.exec(script, DAEMON_HOST);
  if (pid === 0) log(`Couldn't start ${script} on ${DAEMON_HOST}.`);
  else log(`Started ${script} on ${DAEMON_HOST} (pid ${pid}).`);
  return pid !== 0;
}
