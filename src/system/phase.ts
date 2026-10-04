import { NS } from "@ns";
import { Approach } from "system/rpc/scheduler";
import { readBitNodeInfo } from "system/bitnode_info";

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

/** An explicit `approach` in the file's contents, or undefined when there is none (the phase decides). */
export function parseApproachOverride(raw: string): Approach | undefined {
  if (!raw) return undefined;
  try {
    const value = (JSON.parse(raw) as { approach?: unknown }).approach;
    if (value === undefined) return undefined;
    return parseApproach(raw);
  } catch {
    return undefined;
  }
}

/**
 * The phase the game is in, derived by faction_daemon.ts every tick
 * (derivePhase) - what every mode-aware daemon follows unless
 * /etc/scheduler.txt sets `approach` explicitly. Modes used to be switched
 * by hand: a fresh BitNode kept the last run's FACTION_GRIND, GANG stayed
 * on after the gang existed, AUGMENTS was forgotten.
 */
export const PHASE_PATH = "/var/phase.txt";
export type PhaseFile = { approach: Approach; reason: string; writtenAt: number };

/**
 * The phase from the game: GANG while a gang is possible (BitNode 2 or
 * Source-File 2) and not created yet - karma, then creation; AUGMENTS
 * (the buy-and-install loop, which also banks favor) otherwise.
 */
export function derivePhase(gangAvailable: boolean, inGang: boolean): { approach: Approach; reason: string } {
  if (gangAvailable && !inGang) return { approach: Approach.GANG, reason: "gang possible, not created yet" };
  return { approach: Approach.AUGMENTS, reason: gangAvailable ? "gang running" : "no gang in this BitNode" };
}

/**
 * What each phase means for every daemon - the one place behavior is
 * keyed by phase, instead of each daemon comparing approaches on its own.
 */
export type PhasePolicy = {
  // Player and sleeves commit the karma crime until the gang can be
  // created; gang_daemon.ts creates it then.
  chaseGangKarma: boolean;
  // The augmentation buy-and-install loop (faction_daemon.ts).
  installLoop: boolean;
  // Spending narrowed to the faction config's augmentationFocus.
  focusAugmentations: boolean;
  // The player's work slot goes to study_daemon.ts for stats.
  studyForStats: boolean;
  // Installs wait for the faction grinds' favor targets.
  grindFactions: boolean;
  // Share when no status file says whether anyone works a faction.
  shareByDefault: boolean;
};

export function phasePolicy(approach: Approach): PhasePolicy {
  return {
    chaseGangKarma: approach === Approach.GANG,
    installLoop: approach === Approach.AUGMENTS,
    focusAugmentations: approach === Approach.AUGMENTS || approach === Approach.GROW_STATS,
    studyForStats: approach === Approach.GROW_STATS,
    grindFactions: approach === Approach.FACTION_GRIND,
    shareByDefault: approach !== Approach.GROW_STATS && approach !== Approach.GANG,
  };
}

/** The policy of the approach in effect (readApproach). */
export function readPhasePolicy(ns: NS): PhasePolicy {
  return phasePolicy(readApproach(ns));
}

/** The approach in effect: the explicit override if set, else this BitNode's phase file, else HACK. */
export function readApproach(ns: NS): Approach {
  const override = parseApproachOverride(ns.read(SCHEDULER_CONFIG_PATH));
  if (override !== undefined) return override;
  try {
    const phase = JSON.parse(ns.read(PHASE_PATH) || "null") as PhaseFile | null;
    const resetAt = readBitNodeInfo(ns)?.lastNodeReset ?? 0;
    // A phase from an earlier BitNode describes a run that's gone.
    if (phase && phase.writtenAt >= resetAt && Approach[phase.approach] !== undefined) return phase.approach;
  } catch {
    // fall through
  }
  return Approach.HACK;
}
