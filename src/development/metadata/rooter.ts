import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import { ROOTER_MARKER_PATH } from "development/metadata/dispatch";
import * as server_metadata_pb from "development/metadata/server_metadata";

const PORT_OPENERS: { program: string; open: (ns: NS, host: string) => boolean }[] = [
  { program: "BruteSSH.exe", open: (ns, host) => ns.brutessh(host) },
  { program: "FTPCrack.exe", open: (ns, host) => ns.ftpcrack(host) },
  { program: "relaySMTP.exe", open: (ns, host) => ns.relaysmtp(host) },
  { program: "HTTPWorm.exe", open: (ns, host) => ns.httpworm(host) },
  { program: "SQLInject.exe", open: (ns, host) => ns.sqlinject(host) },
];

/**
 * Pure filter, no `ns` dependency — the rooter never computes rootability
 * itself, it only ever reads a status supervisor already computed.
 */
export function selectRootable(servers: server_metadata_pb.Metadata[]): server_metadata_pb.Metadata[] {
  return servers.filter((server) => server.rootStatus === server_metadata_pb.RootStatus.ROOTABLE);
}

/** Opens every port-opener program the player currently owns against `host`, then nukes it. */
function root(ns: NS, host: string): boolean {
  for (const { program, open } of PORT_OPENERS) {
    if (ns.fileExists(program, "home")) open(ns, host);
  }
  return ns.nuke(host);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Rooter", LOG_LEVEL.INFO);

  const client = server_metadata_pb.NewSupervisorServiceClient(ns);

  const res = await client.ListServers({});
  if (res.status !== Codes.OK) {
    await log.warn(`[Rooter] ListServers failed (${Codes[res.status]}): ${res.error}`);
    return;
  }

  const rootable = selectRootable(res.data?.servers ?? []);
  let rootedCount = 0;

  for (const server of rootable) {
    if (!server.hostname) continue;

    await log.info(`[Rooter] Rooting ${server.hostname}...`);
    if (!root(ns, server.hostname)) {
      // Ports must have been insufficient after all (a stale ROOTABLE
      // classification, e.g. a race with a concurrent crawl). Leave its
      // status untouched — it'll be picked up again on the next pass
      // rather than being incorrectly marked ROOTED.
      await log.warn(`[Rooter] Failed to root ${server.hostname}; leaving it for the next pass.`);
      continue;
    }

    const patched = await client.PatchMetadata({
      server: { hostname: server.hostname, rootStatus: server_metadata_pb.RootStatus.ROOTED },
    });
    if (patched.status !== Codes.OK) {
      await log.error(`[Rooter] Rooted ${server.hostname} but failed to update its status (${Codes[patched.status]}): ${patched.error}`);
      continue;
    }
    rootedCount++;
  }

  // Last action: a free ns.write() the dispatch background task polls
  // instead of paying for ns.scriptRunning() (see server_metadata.md).
  ns.write(ROOTER_MARKER_PATH, String(Date.now()), "w");

  await log.info(`[Rooter] Rooted ${rootedCount}/${rootable.length} server(s).`);
}
