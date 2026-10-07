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
 * The hacking multiplier (player x BitNode) at which `exp` hacking
 * experience reaches `level`, by the game's skill formula: level =
 * mult x (32 ln(exp + 534.6) - 200). Level grows with the log of exp, so
 * past a point only the multiplier moves it - BN12 sat at 2.96 needing
 * ~4.4 for Daedalus's 2500.
 */
export function requiredHackingMult(level: number, exp: number): number {
  return level / (32 * Math.log(exp + 534.6) - 200);
}

// Daedalus's installed-augmentation requirement when the BitNode's isn't recorded (SF5 records it).
export const DEFAULT_DAEDALUS_AUGS = 30;

export type PhaseInputs = {
  gangAvailable: boolean;
  inGang: boolean;
  // Some faction (not the gang's) takes donations.
  donationReady: boolean;
  // The faction config's pursueRedPill: aim at the BitNode's end.
  pursueFinish: boolean;
  hackingMult: number;
  requiredHackingMult: number;
  inDaedalus: boolean;
  // Daedalus's invite also needs this many installed augmentations
  // (BitNodeMultipliers.DaedalusAugsRequirement; NeuroFlux counts once).
  installedAugs: number;
  daedalusAugs: number;
};

/**
 * Whether installing what's pending meets Daedalus's count: installed plus
 * pending, NeuroFlux not counted (it's one entry however many levels).
 * Once true, the install should go ahead - BN12's third run had 20 pending
 * for 7 missing and kept saving for ever-dearer augmentations instead.
 */
export function daedalusAugsCovered(installedAugs: number, pending: string[], daedalusAugs: number): boolean {
  const fresh = new Set(pending.filter((name) => name !== "NeuroFlux Governor"));
  return installedAugs + fresh.size >= daedalusAugs;
}

/** The hacking multiplier is enough but Daedalus's invite still waits on installed augmentations. */
export function daedalusAugsShort(inputs: PhaseInputs): boolean {
  return inputs.pursueFinish && !inputs.inDaedalus && inputs.hackingMult >= inputs.requiredHackingMult && inputs.installedAugs < inputs.daedalusAugs;
}

/**
 * The phase from the game, toward the BitNode's finish line:
 * - GANG while a gang is possible and not created yet (karma, then creation);
 * - DAEDALUS (with pursueFinish) once the hacking multiplier can reach
 *   Daedalus's requirement in one stint and enough augmentations are
 *   installed for its invite, or Daedalus is joined. DAEDALUS buys only
 *   The Red Pill, so entering it short of augmentations never ends: BN12's
 *   third run sat there 2.8 h with 24 of 31 and $2 quadrillion;
 * - FACTION_GRIND (favor) while no faction takes donations - money can't
 *   buy rep yet, and rep gates every augmentation;
 * - AUGMENTS (multiply) otherwise: donations and installs build the
 *   hacking multiplier.
 * The old two-phase version (GANG, then AUGMENTS for good) installed every
 * 15 minutes for whatever was affordable, never reached donation favor in
 * 15 hours, and had no notion of the finish line.
 */
export function derivePhase(inputs: PhaseInputs): { approach: Approach; reason: string } {
  if (inputs.gangAvailable && !inputs.inGang) return { approach: Approach.GANG, reason: "gang possible, not created yet" };
  const mult = `hacking mult ${inputs.hackingMult.toFixed(2)} of ${inputs.requiredHackingMult.toFixed(2)}`;
  if (inputs.pursueFinish && inputs.inDaedalus) return { approach: Approach.DAEDALUS, reason: "Daedalus joined" };
  const short = daedalusAugsShort(inputs);
  if (inputs.pursueFinish && inputs.hackingMult >= inputs.requiredHackingMult && !short) return { approach: Approach.DAEDALUS, reason: `${mult}: Daedalus within one stint` };
  const augs = short ? `; Daedalus needs ${inputs.daedalusAugs} installed augmentations (have ${inputs.installedAugs})` : "";
  if (!inputs.donationReady) return { approach: Approach.FACTION_GRIND, reason: `no faction takes donations yet${augs}` };
  return { approach: Approach.AUGMENTS, reason: (inputs.pursueFinish ? mult : "donations open") + augs };
}

/**
 * What each phase means for every daemon - the one place behavior is
 * keyed by phase, instead of each daemon comparing approaches on its own.
 */
export type PhasePolicy = {
  // Sleeves commit the karma crime until the gang can be created;
  // gang_daemon.ts creates it then.
  chaseGangKarma: boolean;
  // The player commits it too. Not in GANG any more: the player's work
  // slot goes to the donation target instead, and to the crime only once
  // donations are open or without sleeves (playerChasesKarma). BN12's second run spent its
  // first ~7.5 hours with the player on Homicide; everything after
  // donations opened took ~2.6 hours, so the run's length was set by when
  // favor work started.
  playerKarma: boolean;
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
  // FACTION_GRIND's favor plan aims at the one faction closest to donation
  // favor (any favor, for NeuroFlux and everything else it sells), not just
  // at factions selling one particular big augmentation.
  donationTarget: boolean;
  // Only The Red Pill is bought; installs only bank favor or install it.
  redPillOnly: boolean;
  // At least this fraction of the fleet runs share while anyone works a
  // faction: in FACTION_GRIND rep is the only bottleneck and the hacking
  // money it costs can't buy rep yet (BN12: $80T/min vs 756 rep/min).
  shareFleetFraction: number;
  // What each IPvGO opponent's bonus is worth now (go_daemon.ts plays the
  // most weighted bonus per second): Illuminati faster hack/grow/weaken,
  // The Black Hand hacking money, Daedalus reputation, Netburners hacknet
  // production, Slum Snakes crime success, Tetrads combat stats.
  goWeights: Record<string, number>;
};

// Money from hacking matters in every phase; the rest follows the phase.
// Reputation gates everything until donations open and the Red Pill after.
const GO_WEIGHTS_HACKING = { Illuminati: 1, "The Black Hand": 1, Daedalus: 0.5, Netburners: 0.3, "Slum Snakes": 0.1, Tetrads: 0.1 };
const GO_WEIGHTS_BY_APPROACH: Partial<Record<Approach, Record<string, number>>> = {
  // Karma comes from crime: its success rate, and the combat stats behind it.
  [Approach.GANG]: { "Slum Snakes": 1, Tetrads: 0.6, Illuminati: 0.6, "The Black Hand": 0.6, Daedalus: 0.2, Netburners: 0.2 },
  // Reputation gates every augmentation; hacking pays for them.
  [Approach.AUGMENTS]: { Daedalus: 1, Illuminati: 0.7, "The Black Hand": 0.7, Netburners: 0.3, "Slum Snakes": 0.1, Tetrads: 0.1 },
  [Approach.FACTION_GRIND]: { Daedalus: 1, Illuminati: 0.7, "The Black Hand": 0.7, Netburners: 0.3, "Slum Snakes": 0.1, Tetrads: 0.1 },
  // Hacking speed and money build the level; Daedalus rep for the Red Pill.
  [Approach.DAEDALUS]: { Illuminati: 1, "The Black Hand": 0.8, Daedalus: 0.8, Netburners: 0.3, "Slum Snakes": 0.1, Tetrads: 0.1 },
  [Approach.GROW_STATS]: { Tetrads: 1, Illuminati: 0.5, "The Black Hand": 0.5, Daedalus: 0.3, Netburners: 0.2, "Slum Snakes": 0.2 },
};

export function phasePolicy(approach: Approach): PhasePolicy {
  return {
    chaseGangKarma: approach === Approach.GANG,
    playerKarma: false,
    installLoop: approach === Approach.AUGMENTS,
    focusAugmentations:
      approach === Approach.AUGMENTS || approach === Approach.GROW_STATS || approach === Approach.FACTION_GRIND || approach === Approach.DAEDALUS || approach === Approach.GANG,
    studyForStats: approach === Approach.GROW_STATS,
    // GANG works toward donation favor too (the player, while sleeves chase karma).
    grindFactions: approach === Approach.FACTION_GRIND || approach === Approach.DAEDALUS || approach === Approach.GANG,
    donationTarget: approach === Approach.FACTION_GRIND || approach === Approach.GANG,
    redPillOnly: approach === Approach.DAEDALUS,
    shareFleetFraction: approach === Approach.FACTION_GRIND || approach === Approach.GANG ? 0.6 : 0,
    shareByDefault: approach !== Approach.GROW_STATS && approach !== Approach.GANG,
    goWeights: GO_WEIGHTS_BY_APPROACH[approach] ?? GO_WEIGHTS_HACKING,
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
