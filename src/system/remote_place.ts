import { NS } from "@ns";
import { DAEMON_HOST, readDaemonHosts, writeDaemonHosts } from "system/remote_state";
import { MANAGED_DAEMONS, scriptClosure } from "system/reload_plan";

/**
 * Runs daemons that don't fit on a small home yet (a fresh BitNode starts
 * at 32 GB) on other servers: first a hacked server with room
 * (placeDaemon), else DAEMON_HOST, a purchased server bought for it. A
 * daemon that reads or writes home's files keeps them in step through
 * system/remote_state.ts; the faction services need none
 * (docs/faction_split.md).
 */

export type HostRoom = { host: string; maxRam: number; usedRam: number; daemonHost: boolean };

/**
 * Where a daemon needing `ram` goes, among rooted hacked servers: a server
 * already hosting daemons if one has room (smallest room first, so daemons
 * pack together), else the smallest fresh server big enough - its workers
 * are stopped for it, and the bigger servers stay with the workers.
 */
export function pickDaemonHost(rooms: HostRoom[], ram: number): { host: string; fresh: boolean } | undefined {
  const packed = rooms
    .filter((r) => r.daemonHost && r.maxRam - r.usedRam >= ram)
    .sort((a, b) => a.maxRam - a.usedRam - (b.maxRam - b.usedRam))[0];
  if (packed) return { host: packed.host, fresh: false };
  const fresh = rooms.filter((r) => !r.daemonHost && r.maxRam >= ram).sort((a, b) => a.maxRam - b.maxRam)[0];
  return fresh ? { host: fresh.host, fresh: true } : undefined;
}

/** Every server reachable from home. */
function allHosts(ns: NS): string[] {
  const seen = new Set(["home"]);
  const queue = ["home"];
  while (queue.length > 0) {
    for (const next of ns.scan(queue.shift() as string)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

// Hacknet servers lose hash production to RAM used on them.
const HACKNET = /^hacknet-(server|node)-\d+$/;

/** Drops recorded daemon hosts that no longer run a managed daemon (an install ends them all). */
export function pruneDaemonHosts(ns: NS): void {
  const kept = readDaemonHosts(ns).filter(
    (host) => ns.serverExists(host) && ns.ps(host).some((p) => MANAGED_DAEMONS.includes(p.filename.replace(/^\//, "")))
  );
  writeDaemonHosts(ns, kept);
}

/**
 * Starts `script` on a hacked server with room (pickDaemonHost), recording
 * it as a daemon host; else on DAEMON_HOST (placeOnDaemonHost). True if
 * it's running somewhere off home afterwards. Never a purchased server
 * other than DAEMON_HOST: purchased_server_daemon.ts deletes and upgrades
 * those.
 */
export function placeDaemon(ns: NS, script: string, log: (line: string) => void): boolean {
  const recorded = readDaemonHosts(ns);
  if ([...recorded, DAEMON_HOST].some((host) => ns.serverExists(host) && ns.isRunning(script, host))) return true;
  const ram = ns.getScriptRam(script, "home");
  if (!(ram > 0)) {
    log(`${script} can't be loaded (RAM 0); not placing it.`);
    return false;
  }
  const purchased = new Set(ns.cloud.getServerNames());
  const rooms: HostRoom[] = allHosts(ns)
    .filter((host) => host !== "home" && host !== DAEMON_HOST && !purchased.has(host) && !HACKNET.test(host) && ns.hasRootAccess(host))
    .map((host) => ({ host, maxRam: ns.getServerMaxRam(host), usedRam: ns.getServerUsedRam(host), daemonHost: recorded.includes(host) }));
  const pick = pickDaemonHost(rooms, ram);
  if (pick) {
    // Recorded first, so the scheduler stops putting workers there.
    writeDaemonHosts(ns, [...recorded, pick.host]);
    if (pick.fresh) ns.killall(pick.host);
    if (ns.scp(scriptClosure(ns, script), pick.host, "home")) {
      const pid = ns.exec(script, pick.host);
      if (pid !== 0) {
        log(`Started ${script} (${ram.toFixed(1)} GB) on ${pick.host} (${ns.getServerMaxRam(pick.host)} GB, pid ${pid}).`);
        return true;
      }
    }
    log(`Couldn't start ${script} on ${pick.host}; trying ${DAEMON_HOST}.`);
  }
  return placeOnDaemonHost(ns, script, log);
}

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
