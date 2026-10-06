import { DAEMON_HOST } from "system/remote_state";
import { NS } from "@ns";

/**
 * The network, read live. network_daemon.ts writes NETWORK_PATH every tick
 * for daemons that want server details (backdoor paths, organizations);
 * daemons that only need hosts to run on (liveWorkerHosts) scan themselves.
 *
 * This replaces the supervisor's server registry: a cache of crawled
 * records, kept over RPC and on disk, that went stale - root status stuck
 * "rooted" after installs, hacking level lagging so the best targets were
 * missing, deleted purchased servers crashing daemons, crawler pushes
 * timing out. Live reads are cheap, so nothing here is cached across ticks.
 */
export const NETWORK_PATH = "/var/network.txt";

export type ServerKind = "home" | "npc" | "purchased" | "hacknet";

export type NetworkServer = {
  host: string;
  // Hops from home, home excluded - for ns.singularity.connect.
  path: string[];
  kind: ServerKind;
  rooted: boolean;
  backdoor: boolean;
  organization: string;
  maxRam: number;
  maxMoney: number;
  requiredLevel: number;
  portsRequired: number;
};

export type NetworkFile = { servers: NetworkServer[]; hackingLevel: number; writtenAt: number };

export const HOME = "home";
const HACKNET_NAME = /^hacknet-(server|node)-\d+$/;
// The purchased server kept for daemons (system/remote_state.ts) - never a
// worker host, so batches can't take its RAM.
export { DAEMON_HOST };

export function classifyKind(host: string, purchasedByPlayer: boolean): ServerKind {
  if (host === HOME) return "home";
  if (HACKNET_NAME.test(host)) return "hacknet";
  return purchasedByPlayer ? "purchased" : "npc";
}

/** Every host reachable from home with its path (breadth-first ns.scan). */
export function scanWithPaths(ns: NS): { host: string; path: string[] }[] {
  const out = [{ host: HOME, path: [] as string[] }];
  const seen = new Set([HOME]);
  for (let i = 0; i < out.length; i++) {
    for (const next of ns.scan(out[i].host)) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push({ host: next, path: [...out[i].path, next] });
    }
  }
  return out;
}

/**
 * Hosts workers may run on, from a live scan: rooted, not home (the
 * scheduler adds home's own share), not a Hacknet server (RAM used there
 * cuts hash production).
 */
export function liveWorkerHosts(ns: NS): string[] {
  return scanWithPaths(ns)
    .map((s) => s.host)
    .filter((host) => host !== HOME && host !== DAEMON_HOST && !HACKNET_NAME.test(host) && ns.hasRootAccess(host));
}

/** Port openers, in the order the game expects them. */
export const PORT_OPENERS: { program: string; open: (ns: NS, host: string) => boolean }[] = [
  { program: "BruteSSH.exe", open: (ns, host) => ns.brutessh(host) },
  { program: "FTPCrack.exe", open: (ns, host) => ns.ftpcrack(host) },
  { program: "relaySMTP.exe", open: (ns, host) => ns.relaysmtp(host) },
  { program: "HTTPWorm.exe", open: (ns, host) => ns.httpworm(host) },
  { program: "SQLInject.exe", open: (ns, host) => ns.sqlinject(host) },
];

/** Opens every port the owned openers can against `host`, then nukes it. */
export function root(ns: NS, host: string): boolean {
  for (const { program, open } of PORT_OPENERS) {
    if (ns.fileExists(program, HOME)) open(ns, host);
  }
  return ns.nuke(host);
}

/** The server detail daemons read from NETWORK_PATH (backdoor targets, stock organizations). */
export function snapshotNetwork(ns: NS): NetworkFile {
  const servers = scanWithPaths(ns).map(({ host, path }): NetworkServer => {
    const s = ns.getServer(host);
    return {
      host,
      path,
      kind: classifyKind(host, s.purchasedByPlayer),
      rooted: s.hasAdminRights,
      backdoor: s.backdoorInstalled ?? false,
      organization: s.organizationName ?? "",
      maxRam: s.maxRam,
      maxMoney: s.moneyMax ?? 0,
      requiredLevel: s.requiredHackingSkill ?? 0,
      portsRequired: s.numOpenPortsRequired ?? 0,
    };
  });
  return { servers, hackingLevel: ns.getHackingLevel(), writtenAt: Date.now() };
}

/** NETWORK_PATH's contents, or undefined when missing, corrupt or older than `maxAgeMs`. */
export function readNetwork(ns: NS, maxAgeMs = 60_000): NetworkFile | undefined {
  try {
    const file = JSON.parse(ns.read(NETWORK_PATH) || "null") as NetworkFile | null;
    return file && Date.now() - file.writtenAt <= maxAgeMs ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Servers worth a backdoor: NPC, rooted, within hacking level, not done
 * yet, and never w0r1d_d43m0n - backdooring it ends the BitNode, which is
 * only ever done on purpose (tools/finish_bitnode.js).
 */
export function backdoorTargets(file: NetworkFile): NetworkServer[] {
  return file.servers.filter(
    (s) => s.kind === "npc" && s.rooted && !s.backdoor && s.requiredLevel <= file.hackingLevel && s.host !== "w0r1d_d43m0n"
  );
}

/**
 * Kills the prep workers (weaken/grow with prep's arguments: target, delay
 * 0) aimed at `target`, on every host; returns how many were killed. A
 * prep at security 100 runs for a long time, and when the scheduler drops
 * the target they kept the fleet's RAM to no purpose - BN12 started with
 * every host tied up by preps for targets dropped a second later.
 */
export function killPrepWorkers(ns: NS, target: string, scripts: string[]): number {
  let killed = 0;
  for (const { host } of scanWithPaths(ns)) {
    for (const p of ns.ps(host)) {
      if (scripts.includes(p.filename.replace(/^\//, "")) && p.args[0] === target && p.args[1] === 0 && ns.kill(p.pid)) killed++;
    }
  }
  return killed;
}
