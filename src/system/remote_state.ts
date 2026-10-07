import { NS } from "@ns";
import { SupervisorServicePort } from "system/rpc/server_metadata";
import { Codes } from "system/rpc/status";
import * as state_pb from "system/rpc/state";
import { Deadline } from "system/deadline";

/**
 * Daemons on servers other than home. They coordinate through files on
 * home (/etc configs, /var status) - ns.read/ns.write on another server
 * would see only that server's files. A remote daemon brackets each tick:
 *
 *   const synced = await pullState(ns, deadline);   // home's files -> here
 *   await tick(...);                                 // unchanged ns.read/ns.write
 *   await pushState(ns, synced, deadline);           // what changed -> home
 *
 * through the supervisor's StateService (system/rpc/state.proto), so its
 * own code stays as it is on home. Home keeps the only copy that counts:
 * persistence, the bridge mirror and every tool are unchanged.
 */
export const HOME = "home";
// A purchased server reserved for daemons that don't fit on home yet
// (boot.ts places them there with system/remote_place.ts).
export const DAEMON_HOST = "daemons-0";
// Hacked servers boot has put daemons on (system/remote_place.ts's
// placeDaemon) - workers stay off them, and the reloader looks there too.
export const DAEMON_HOSTS_PATH = "/var/daemon_hosts.txt";
export type DaemonHostsFile = { hosts: string[]; writtenAt: number };

/** Hosts recorded in DAEMON_HOSTS_PATH ([] when missing or unreadable). */
export function readDaemonHosts(ns: NS): string[] {
  try {
    const hosts = (JSON.parse(ns.read(DAEMON_HOSTS_PATH) || "{}") as Partial<DaemonHostsFile>).hosts;
    return Array.isArray(hosts) ? hosts.map(String) : [];
  } catch {
    return [];
  }
}

export function writeDaemonHosts(ns: NS, hosts: string[]): void {
  ns.write(DAEMON_HOSTS_PATH, JSON.stringify({ hosts: [...new Set(hosts)], writtenAt: Date.now() } satisfies DaemonHostsFile), "w");
}

/** Every server other than home that may run daemons: the purchased fallback and the recorded hacked ones. */
export function daemonHosts(ns: NS): string[] {
  return [DAEMON_HOST, ...readDaemonHosts(ns).filter((h) => h !== DAEMON_HOST)];
}

// What's synced: configs and status files - not logs, the supervisor's own
// cache, tool output or the big append-only histories.
export const STATE_PREFIXES = ["/etc/", "/var/"];
export const STATE_EXCLUDE = ["/var/log/", "/var/supervisor/", "/var/claude_out/", "/var/go_history.txt", "/var/monitoring/gauge/"];

export function isRemote(ns: NS): boolean {
  return ns.getHostname() !== HOME;
}

/** Game paths with a leading slash (ns.ls gives "var/x.txt"). */
export function absolute(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function matchesState(path: string, prefixes: string[], exclude: string[]): boolean {
  const p = absolute(path);
  return prefixes.some((pre) => p.startsWith(pre)) && !exclude.some((ex) => p.startsWith(ex));
}

/** The supervisor's StateService handlers, serving home's files. */
export function createStateHandlers(ns: NS): state_pb.StateServiceHandlers {
  return {
    List: (req) => ({
      paths: ns
        .ls(HOME)
        .map(absolute)
        .filter((p) => matchesState(p, req.prefixes ?? STATE_PREFIXES, req.exclude ?? [])),
    }),
    GetMany: (req) => ({ documents: (req.paths ?? []).map((path) => ({ path, content: ns.read(path) })) }),
    PutMany: (req) => {
      let written = 0;
      for (const doc of req.documents ?? []) {
        // A remote daemon's log lines land in its host's folder on home (/var/log/<host>/).
        if (!doc.path || !matchesState(doc.path, STATE_PREFIXES, [])) continue;
        ns.write(doc.path, doc.content ?? "", doc.append ? "a" : "w");
        written++;
      }
      return { written };
    },
  };
}

function client(ns: NS) {
  // StateService rides on the supervisor's port, like PlayerService.
  return state_pb.NewStateServiceClient(ns, SupervisorServicePort);
}

/** Copies home's state files here; returns what was pulled (path -> content) for pushState to diff against. */
export async function pullState(ns: NS, deadline: Deadline | number): Promise<Map<string, string>> {
  const pulled = new Map<string, string>();
  const c = client(ns);
  const listed = await c.List({ prefixes: STATE_PREFIXES, exclude: STATE_EXCLUDE }, deadline);
  if (listed.status !== Codes.OK) return pulled;
  const got = await c.GetMany({ paths: listed.data?.paths ?? [] }, deadline);
  if (got.status !== Codes.OK) return pulled;
  for (const doc of got.data?.documents ?? []) {
    if (!doc.path) continue;
    ns.write(doc.path, doc.content ?? "", "w");
    pulled.set(doc.path, doc.content ?? "");
  }
  return pulled;
}

/**
 * Sends home every state file here that's new or changed since pullState,
 * and this server's new log lines (appended to home's copy, then cleared
 * here - home's log_rotator.js rotates them; the bridge mirrors them).
 */
export async function pushState(ns: NS, pulled: Map<string, string>, deadline: Deadline | number): Promise<number> {
  const files = ns.ls(ns.getHostname()).map(absolute);
  const changed: state_pb.Document[] = files
    .filter((p) => matchesState(p, STATE_PREFIXES, STATE_EXCLUDE))
    .map((path) => ({ path, content: ns.read(path) }))
    .filter((doc) => pulled.get(doc.path ?? "") !== doc.content);
  const logs: state_pb.Document[] = files
    .filter((p) => p.startsWith("/var/log/") && !/\.\d+\.txt$/.test(p))
    .map((path) => ({ path, content: ns.read(path), append: true }))
    .filter((doc) => (doc.content ?? "").length > 0);
  if (changed.length + logs.length === 0) return 0;
  const res = await client(ns).PutMany({ documents: [...changed, ...logs] }, deadline);
  if (res.status !== Codes.OK) return 0;
  for (const doc of logs) ns.write(doc.path as string, "", "w");
  return res.data?.written ?? 0;
}
