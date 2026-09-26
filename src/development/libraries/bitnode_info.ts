import { NS } from "@ns";

/**
 * Facts about the current BitNode, written once per boot by
 * detect_capabilities.ts and read (0 GB) by anything that needs them:
 * which node, when it started, owned Source-Files, and - with Source-File 5
 * or inside BitNode 5 - ns.getBitNodeMultipliers(). Reading the multipliers
 * directly costs RAM on every script that does it; this way only the one-shot
 * detector pays.
 *
 * Rewritten every boot, so it never outlives a BitNode change (the old
 * cached capability flags did). Deliberately outside wipe_data.ts's
 * WIPE_PREFIXES.
 */
export const BITNODE_INFO_PATH = "/var/bitnode/current.txt";
const VERSION = 1;

export type BitNodeInfo = {
  v: number;
  node: number;
  // ns.getResetInfo().lastNodeReset - changes only when a new BitNode starts.
  lastNodeReset: number;
  sourceFiles: Record<string, number>;
  // ns.getBitNodeMultipliers(); absent without Source-File 5 (or BitNode 5).
  multipliers?: Record<string, number>;
  writtenAt: number;
};

/** getBitNodeMultipliers needs Source-File 5, or to be in BitNode 5. */
export function bitNodeMultipliersAvailable(currentNode: number, sourceFiles: Map<number, number>): boolean {
  return currentNode === 5 || (sourceFiles.get(5) ?? 0) >= 1;
}

/** Parses the file's contents; undefined for empty, corrupt, or another version's format. */
export function parseBitNodeInfo(raw: string): BitNodeInfo | undefined {
  if (!raw) return undefined;
  try {
    const info = JSON.parse(raw) as BitNodeInfo;
    return info.v === VERSION && typeof info.node === "number" ? info : undefined;
  } catch {
    return undefined;
  }
}

export function readBitNodeInfo(ns: NS): BitNodeInfo | undefined {
  return parseBitNodeInfo(ns.read(BITNODE_INFO_PATH));
}

export function buildBitNodeInfo(
  node: number,
  lastNodeReset: number,
  sourceFiles: Map<number, number>,
  multipliers: Record<string, number> | undefined,
  now: number
): BitNodeInfo {
  return { v: VERSION, node, lastNodeReset, sourceFiles: Object.fromEntries([...sourceFiles].map(([k, v]) => [String(k), v])), multipliers, writtenAt: now };
}
