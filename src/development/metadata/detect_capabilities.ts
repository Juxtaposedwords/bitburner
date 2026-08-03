import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

/**
 * ns.singularity requires Source-File 4 outside BitNode 4 (see
 * server_metadata.md) — this is that check, pure so it's directly
 * testable without needing a live ns.getResetInfo() call.
 */
export function computeSingularityAvailable(currentNode: number, ownedSF: Map<number, number>): boolean {
  return currentNode === 4 || (ownedSF.get(4) ?? 0) >= 1;
}

/**
 * The only place in the codebase that calls ns.getResetInfo() (1 GB, plain
 * base NS, no Source-File requirement) — a one-shot job, not a daemon.
 * boot.ts only launches this when supervisor doesn't already have
 * singularityAvailable set (see PlayerService/PatchPlayerMetadata in
 * server_metadata.md); ns.singularity itself is never referenced here or
 * anywhere outside tools/program_shopper.ts.
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "CapabilityDetector", LOG_LEVEL.INFO);

  const resetInfo = ns.getResetInfo();
  const singularityAvailable = computeSingularityAvailable(resetInfo.currentNode, resetInfo.ownedSF);

  const client = player_metadata_pb.NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort);
  const res = await client.PatchPlayerMetadata({ player: { singularityAvailable } });
  if (res.status !== Codes.OK) {
    await log.warn(`[CapabilityDetector] PatchPlayerMetadata failed (${Codes[res.status]}): ${res.error}`);
    return;
  }

  await log.info(`[CapabilityDetector] singularityAvailable = ${singularityAvailable}.`);
}
