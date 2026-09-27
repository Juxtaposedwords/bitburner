import { NS } from "@ns";
import { Approach } from "development/metadata/scheduler";

/**
 * The scheduler approach (scheduler.proto's Approach), read straight from
 * scheduler_daemon.ts's persisted config file instead of over RPC.
 *
 * Every daemon that changes behavior by approach used to ask the scheduler
 * over RPC each tick and treat a failed call as "not that mode". Right after
 * an install boot launches the scheduler last, the call timed out, and the
 * faction daemon quietly dropped AUGMENTS mode - buying NeuroFlux instead of
 * saving for QLink, whose price every purchase raised 1.9x. The file is the
 * source of truth (PatchSchedulerConfig writes through to it), costs 0 GB to
 * read, and can't time out.
 */
export const SCHEDULER_CONFIG_PATH = "/etc/scheduler.txt";

/** The approach in the file's contents: a number, or an enum name if hand-edited; HACK if missing or unreadable. */
export function parseApproach(raw: string): Approach {
  if (!raw) return Approach.HACK;
  try {
    const value = (JSON.parse(raw) as { approach?: unknown }).approach;
    if (typeof value === "number" && Approach[value] !== undefined) return value as Approach;
    if (typeof value === "string" && value in Approach) return Approach[value as keyof typeof Approach];
    return Approach.HACK;
  } catch {
    return Approach.HACK;
  }
}

export function readApproach(ns: NS): Approach {
  return parseApproach(ns.read(SCHEDULER_CONFIG_PATH));
}
