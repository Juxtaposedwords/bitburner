import { NS } from "@ns";
import { BITNODE_INFO_PATH, bitNodeMultipliersAvailable, buildBitNodeInfo } from "system/bitnode_info";
import { createLogger, LOG_LEVEL } from "system/logs";
import { Codes } from "system/rpc/status";
import * as player_metadata_pb from "system/rpc/player_metadata";
import * as server_metadata_pb from "system/rpc/server_metadata";

/**
 * ns.singularity requires Source-File 4 outside BitNode 4 (see
 * server_metadata.md) — this is that check, pure so it's directly
 * testable without needing a live ns.getResetInfo() call.
 */
export function computeSingularityAvailable(currentNode: number, ownedSF: Map<number, number>): boolean {
  return currentNode === 4 || (ownedSF.get(4) ?? 0) >= 1;
}

/**
 * ns.gang requires Source-File 2 outside BitNode 2 (see
 * server_metadata.md) — same shape as computeSingularityAvailable, just a
 * different Source-File/BitNode number and a genuinely independent
 * capability (owning one doesn't imply the other).
 */
export function computeGangAvailable(currentNode: number, ownedSF: Map<number, number>): boolean {
  return currentNode === 2 || (ownedSF.get(2) ?? 0) >= 1;
}

/**
 * The only place in the codebase that calls ns.getResetInfo() (1 GB, plain
 * base NS, no Source-File requirement) — a one-shot job, not a daemon.
 * boot.ts only launches this when supervisor doesn't already have
 * singularityAvailable set (see PlayerService/PatchPlayerMetadata in
 * server_metadata.md); ns.singularity itself is never referenced here or
 * anywhere outside hacking/program_shopper.ts.
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "CapabilityDetector", LOG_LEVEL.INFO);

  const resetInfo = ns.getResetInfo();

  // The current BitNode's facts for every other script (bitnode_info.ts) -
  // written first, so it's there even if the supervisor patch below fails.
  const multipliers = bitNodeMultipliersAvailable(resetInfo.currentNode, resetInfo.ownedSF)
    ? (ns.getBitNodeMultipliers() as unknown as Record<string, number>)
    : undefined;
  ns.write(
    BITNODE_INFO_PATH,
    JSON.stringify(buildBitNodeInfo(resetInfo.currentNode, resetInfo.lastNodeReset, resetInfo.ownedSF, multipliers, Date.now())),
    "w"
  );

  const singularityAvailable = computeSingularityAvailable(resetInfo.currentNode, resetInfo.ownedSF);
  const gangAvailable = computeGangAvailable(resetInfo.currentNode, resetInfo.ownedSF);

  const client = player_metadata_pb.NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort);
  const res = await client.PatchPlayerMetadata({ player: { singularityAvailable, gangAvailable } });
  if (res.status !== Codes.OK) {
    await log.warn(`[CapabilityDetector] PatchPlayerMetadata failed (${Codes[res.status]}): ${res.error}`);
    return;
  }

  await log.info(
    `[CapabilityDetector] BitNode ${resetInfo.currentNode}, multipliers ${multipliers ? "recorded" : "unavailable (needs SF5)"}; ` +
      `singularityAvailable = ${singularityAvailable}, gangAvailable = ${gangAvailable}.`
  );
}
