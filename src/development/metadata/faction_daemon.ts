import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { clearInstallPending, readInstallPending, touchInstallPending } from "development/libraries/install_handshake";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import {
  AugmentationInfo,
  CITY_FACTION_NAMES,
  COMPANY_FACTION_EMPLOYER,
  COMPANY_FACTION_NAMES,
  CRIMINAL_FACTION_NAMES,
  decideAugmentationPurchase,
  decideCrimeForKills,
  decideDonation,
  DonationDecision,
  decideEligibilityStandDown,
  decideFactionsToJoin,
  decideInstallReady,
  decidePreInstall,
  decideWorkTarget,
  EligibilityAction,
  EligibilitySnapshot,
  findBlockingRequirement,
  hasAnyCityFaction,
  PurchaseDecision,
  requirementToAction,
} from "development/metadata/faction_decisions";
import * as player_metadata_pb from "development/metadata/player_metadata";
import { Approach, NewSchedulerServiceClient } from "development/metadata/scheduler";
import {
  combineMultipliers,
  compareInstall,
  effectiveSkillMult,
  hackingGoal,
  matchesFocus,
  PENDING_BOOST_PATH,
  PendingBoost,
} from "development/libraries/skill_progress";
import * as server_metadata_pb from "development/metadata/server_metadata";

// FactionName/FactionWorkType/CompanyName/CityName/JobField/CrimeType/
// GymLocationName are big string-literal unions not exported by name
// from "@ns" - pulled out structurally the same way hacknet_daemon.ts
// derives HashUpgradeName, rather than duplicating the literal list
// here. Our own decision logic treats all of these as plain strings
// throughout (see faction_decisions.ts) since it has no `ns` dependency;
// these casts are only needed at the boundary where a plain string
// crosses back into an ns.singularity.* call.
type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];
type FactionWorkTypeType = Parameters<NS["singularity"]["workForFaction"]>[1];
type CityNameType = Parameters<NS["singularity"]["travelToCity"]>[0];
type CompanyNameType = Parameters<NS["singularity"]["applyToCompany"]>[0];
type JobFieldType = Parameters<NS["singularity"]["applyToCompany"]>[1];
type CrimeTypeType = Parameters<NS["singularity"]["commitCrime"]>[0];
type GymLocationNameType = Parameters<NS["singularity"]["gymWorkout"]>[0];

const WORLD_DAEMON = "w0r1d_d43m0n";

/**
 * The third file allowed to import ns.singularity (after
 * tools/program_shopper.ts and backdoor_daemon.ts) - kept isolated for the
 * same RAM-cost reason (see server_metadata.md). Only launched by boot.ts
 * when PlayerMetadata.singularityAvailable is true. (A fourth,
 * tools/augmentation_report.ts, reuses this file's own gather/decide
 * exports rather than re-deriving anything - see its module doc.)
 *
 * No RPC service of its own. Faction reputation/augmentation state is
 * cheap to re-derive fresh from ns.singularity.* every tick, and so is
 * membership itself - ns.getPlayer().factions is the live, current list
 * (an earlier version of this file mistakenly persisted its own
 * /var/faction_state.txt copy instead, reasoning that
 * checkFactionInvitations() stops listing a faction once you're a member
 * so membership "can't be re-derived live" - true of that one function,
 * but ns.getPlayer().factions gives it directly. That persisted copy
 * went stale across an installAugmentations reset, which clears
 * Player.factions entirely (confirmed against Bitburner's own
 * PlayerObjectGeneralMethods.ts) but doesn't touch a file already
 * sitting on home - the daemon kept believing it was still joined to
 * factions it had actually lost, forever blocking re-invitation. Reading
 * ns.getPlayer().factions directly every tick has no such staleness
 * window, and as a bonus also correctly picks up any faction joined
 * outside this daemon entirely (e.g. manually, to found a gang) instead
 * of never learning about it.
 *
 * There IS now a small /var/faction_state.txt (same path as the retired
 * membership copy above, but an unrelated concern - see FactionState
 * below): it exists purely to bound crime-for-kills grinding, not to
 * cache anything re-derivable.
 *
 * Active eligibility (pursueCityFactions/pursueCompanyFactions/
 * pursueCriminalFactions below): everything above only ever reacts to
 * checkFactionInvitations() - it never does anything to become eligible
 * for a faction we're not yet invited to. See faction_decisions.ts's own
 * module doc for the getFactionInviteRequirements-driven engine this is
 * built on, and server_metadata.md for the full design writeup (work-slot
 * priority policy, city mutual-exclusivity policy, scope cuts).
 */
export type FactionConfig = {
  enabled: boolean;
  reserveMoney: number;
  maxSpendFraction: number;
  // undefined = accept every faction invitation; set to restrict which
  // factions get auto-joined.
  joinAllowlist?: string[];
  // Both start false: buying spends real money, and installing wipes
  // every running script (a full reboot into bootScript) - opt in
  // explicitly once the join+work loop has been watched running safely.
  autoPurchaseAugmentations: boolean;
  autoInstall: boolean;
  // Buy an augmentation's missing reputation with money at factions that
  // accept donations (see decideDonation). Only acts when
  // autoPurchaseAugmentations is also on - a donation only ever happens to
  // make an augmentation buyable. Needs Formulas.exe for the exact amount.
  autoDonate: boolean;
  // Share of cash one donation (plus the augmentation's price) may use.
  // Separate from maxSpendFraction, which throttles the many small repeated
  // purchases across daemons: a donation is one targeted lump with a known
  // payoff, and at 0.5 a ~$61B NeuroFlux unlock waited for ~$122B cash.
  donationSpendFraction: number;
  // Script to relaunch into after installAugmentations wipes everything.
  bootScript: string;

  // City factions - mutually exclusive within a BitNode run (see
  // hasAnyCityFaction's doc). Off by default: travel itself is cheap and
  // reversible, but this is new behavior worth watching run once before
  // trusting, same posture as autoPurchaseAugmentations/autoInstall.
  pursueCityFactions: boolean;
  // Walked in order; the category stops entirely once ANY of these is
  // joined - editable if a specific city is preferred.
  cityFactionPriority: string[];

  pursueCompanyFactions: boolean;
  companyPriority: string[];
  // JobField passed to applyToCompany - a single config string, not
  // ROI-optimized by salary/rep-gain-rate (deliberate v1 simplification,
  // same tradeoff gang_decisions.ts's decideEquipmentPurchase already
  // accepts for gang equipment).
  companyJobField: string;

  pursueCriminalFactions: boolean;
  criminalFactionPriority: string[];
  // Off by default even under pursueCriminalFactions=true: committing
  // crimes to farm numPeopleKilled is the one genuinely irreversible,
  // game-telegraphed-as-serious action in this whole feature - opt in
  // explicitly. Every other criminal-faction gap (combat stats via
  // gymWorkout) is safe/reversible and needs no separate flag.
  enableCrimeForKills: boolean;
  minCrimeSuccessChance: number;
  // Circuit breaker via /var/faction_state.txt's crimeAttempts - mirrors
  // gang_decisions.ts's decideStandDown/maxCasualties exactly.
  maxCrimeAttempts: number;
  // Must be a real gym in the city pursueCityFactions is already aiming
  // for (gyms only exist in Aevum/Sector-12/Volhaven) - default pairs
  // with cityFactionPriority's default (Sector-12 first).
  gymLocation: string;

  // During Approach.GROW_STATS (see study_daemon.ts): only augmentations
  // raising one of these multipliers are bought or donated for - the level
  // multiplier sits inside an exponent (see skill_progress.ts), so it's worth
  // far more toward the goal than anything else. [] = buy everything.
  growStatsAugmentationFocus: string[];
  // Hacking level GROW_STATS works toward; 0 = w0r1d_d43m0n's requirement
  // once visible, else Daedalus's 2500 (see hackingGoal).
  growStatsHackingGoal: number;
  // During GROW_STATS, install only if it reaches the goal in at most this
  // fraction of the time staying would take (compareInstall's ratio). Below
  // 1 because an install also resets the Hacknet and its study upgrades,
  // which the comparison doesn't count.
  growStatsInstallMaxRatio: number;
};

export const DEFAULT_CONFIG: FactionConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  autoPurchaseAugmentations: false,
  autoInstall: false,
  autoDonate: true,
  donationSpendFraction: 0.9,
  bootScript: "boot.js",

  pursueCityFactions: false,
  cityFactionPriority: [...CITY_FACTION_NAMES],

  pursueCompanyFactions: false,
  companyPriority: [...COMPANY_FACTION_NAMES],
  companyJobField: "Business",

  pursueCriminalFactions: false,
  criminalFactionPriority: [...CRIMINAL_FACTION_NAMES],
  enableCrimeForKills: false,
  minCrimeSuccessChance: 0.5,
  maxCrimeAttempts: 100,
  gymLocation: "Iron Gym",

  growStatsAugmentationFocus: ["hacking", "hacking_exp"],
  growStatsHackingGoal: 0,
  growStatsInstallMaxRatio: 0.8,
};

export const CONFIG_PATH = "/etc/faction.txt";
const STATE_PATH = "/var/faction_state.txt";
const TICK_INTERVAL_MS = 5000;

/** Daemon-owned runtime state, separate from user policy config - same /etc vs /var split as gang_daemon.ts's GangConfig/GangState. Bounds crime-for-kills grinding only; unrelated to the retired membership-persistence concern documented above. */
export type FactionState = { crimeAttempts: number };
const DEFAULT_STATE: FactionState = { crimeAttempts: 0 };

export function loadState(ns: NS): FactionState {
  return loadJsonConfig(ns, STATE_PATH, DEFAULT_STATE);
}

function saveState(ns: NS, state: FactionState): void {
  ns.write(STATE_PATH, JSON.stringify(state, null, 2), "w");
}

/** Every augmentation offered by any joined faction, queried live - no persisted catalog. */
export function gatherCatalog(ns: NS, joinedFactions: string[]): AugmentationInfo[] {
  const catalog: AugmentationInfo[] = [];
  for (const faction of joinedFactions) {
    for (const name of ns.singularity.getAugmentationsFromFaction(faction as FactionNameType)) {
      catalog.push({
        name,
        faction,
        price: ns.singularity.getAugmentationPrice(name),
        repReq: ns.singularity.getAugmentationRepReq(name),
        prereqs: ns.singularity.getAugmentationPrereq(name),
        stats: ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>,
      });
    }
  }
  return catalog;
}

export function gatherReps(ns: NS, joinedFactions: string[]): Record<string, number> {
  const reps: Record<string, number> = {};
  for (const faction of joinedFactions) reps[faction] = ns.singularity.getFactionRep(faction as FactionNameType);
  return reps;
}

/** Augmentations bought but not yet applied via installAugmentations - the owned(true)/owned(false) diff already inlined in tick(), pulled out so augmentation_report.ts shares the same definition. */
export function getPendingAugmentations(ns: NS): string[] {
  const installed = ns.singularity.getOwnedAugmentations(false);
  return ns.singularity.getOwnedAugmentations(true).filter((name) => !installed.includes(name));
}

/** "hacking" if the faction offers it, else whatever's first - see faction_decisions.ts's module doc for why there's no hardcoded faction->workType table. */
function pickWorkType(ns: NS, faction: string): string | undefined {
  const types = ns.singularity.getFactionWorkTypes(faction as FactionNameType);
  return types.includes("hacking") ? "hacking" : types[0];
}

/**
 * ns.singularity.workForFaction restarts the work action (and snaps the
 * game's UI to the work screen) every time it's called, even for the
 * same faction/type already in progress - calling it unconditionally
 * every 5s tick made the UI jump constantly, with no way to navigate
 * elsewhere. Checked via getCurrentWork rather than tracking our own
 * "last assigned" state, so it stays correct even if the player manually
 * starts different work in between ticks.
 */
function isAlreadyWorking(ns: NS, faction: string, workType: string): boolean {
  const current = ns.singularity.getCurrentWork();
  return current?.type === "FACTION" && current.factionName === faction && current.factionWorkType === workType;
}

/** Builds an EligibilitySnapshot from a single ns.getPlayer() call - companyReps starts empty, filled in per-candidate by pursueCompanyFactions. */
function gatherEligibilitySnapshot(player: ReturnType<NS["getPlayer"]>): EligibilitySnapshot {
  return {
    money: player.money,
    skills: {
      hacking: player.skills.hacking,
      strength: player.skills.strength,
      defense: player.skills.defense,
      dexterity: player.skills.dexterity,
      agility: player.skills.agility,
      charisma: player.skills.charisma,
      intelligence: player.skills.intelligence,
    },
    karma: player.karma,
    numPeopleKilled: player.numPeopleKilled,
    city: player.city,
    jobs: player.jobs,
    companyReps: {},
  };
}

/**
 * Only ever produces a `travel` action - city faction invites gate on
 * `city` + `money`, and money isn't something this feature can act on.
 * Stops the whole category dead once ANY city faction is joined
 * (hasAnyCityFaction): city factions are mutually exclusive within a
 * BitNode run (each lists some of the others as `enemies`, permanently
 * banned on join - confirmed via Bitburner's FactionInfo.tsx), and rather
 * than model that asymmetric graph (a second source of truth that could
 * drift), this just stops - correct regardless of the exact graph, since
 * checkFactionInvitations() will never surface an enemy's invite again
 * once we're in one of its enemies, so continuing to chase one after that
 * point would be pure waste. cityFactionPriority controls which one gets
 * pursued first.
 */
function pursueCityFactions(ns: NS, config: FactionConfig, snapshot: EligibilitySnapshot, joinedFactions: string[]): EligibilityAction {
  if (hasAnyCityFaction(joinedFactions)) return { kind: "none" };

  for (const faction of config.cityFactionPriority) {
    if (joinedFactions.includes(faction)) continue;
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    const blocking = findBlockingRequirement(requirements, snapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, snapshot);
    if (action.kind !== "none") return action;
  }
  return { kind: "none" };
}

/**
 * No short-circuit - company factions stack normally, unlike city
 * factions. companyReps is populated live per-candidate (only for
 * whichever employer is actually being evaluated this iteration, not
 * eagerly for all ten) since getCompanyRep needs a real employer name and
 * Fulcrum Secret Technologies' employer (Fulcrum Technologies) differs
 * from its faction name - the one mismatch, resolved via
 * COMPANY_FACTION_EMPLOYER.
 */
function pursueCompanyFactions(ns: NS, config: FactionConfig, snapshot: EligibilitySnapshot, joinedFactions: string[]): EligibilityAction {
  for (const faction of config.companyPriority) {
    if (joinedFactions.includes(faction)) continue;
    const employer = COMPANY_FACTION_EMPLOYER[faction] ?? faction;
    const candidateSnapshot: EligibilitySnapshot = {
      ...snapshot,
      companyReps: { ...snapshot.companyReps, [employer]: ns.singularity.getCompanyRep(employer as CompanyNameType) },
    };
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    const blocking = findBlockingRequirement(requirements, candidateSnapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, candidateSnapshot);
    if (action.kind !== "none") return action;
  }
  return { kind: "none" };
}

/** Data-driven crime selection (see decideCrimeForKills's doc) over every live CrimeType - never a hardcoded "Homicide" string. */
function pickCrimeForKills(ns: NS, minSuccessChance: number): string | undefined {
  const candidates = Object.values(ns.enums.CrimeType).map((crime) => ({
    crime,
    kills: ns.singularity.getCrimeStats(crime as CrimeTypeType).kills,
    successChance: ns.singularity.getCrimeChance(crime as CrimeTypeType),
  }));
  return decideCrimeForKills(candidates, minSuccessChance);
}

/**
 * Walks criminalFactionPriority once. Safe actions (gymWorkout/quitJob/
 * travel) from ANY candidate faction are returned immediately; a
 * commitCrime need is deferred (only the first one found) so every safe
 * option across the whole category is tried first - risk-ascending, same
 * ordering decideEligibilityWorkSlotAction uses one level up. The
 * deferred crime is only actually returned if enableCrimeForKills is on
 * and the /var/faction_state.txt circuit breaker hasn't tripped; tripping
 * is logged once here (not per-candidate) so it doesn't spam.
 */
async function pursueCriminalFactions(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  state: FactionState,
  snapshot: EligibilitySnapshot,
  joinedFactions: string[]
): Promise<EligibilityAction> {
  let deferredCrime: EligibilityAction | undefined;

  for (const faction of config.criminalFactionPriority) {
    if (joinedFactions.includes(faction)) continue;
    const requirements = ns.singularity.getFactionInviteRequirements(faction as FactionNameType);
    const blocking = findBlockingRequirement(requirements, snapshot);
    if (!blocking) continue;
    const action = requirementToAction(blocking, config.companyJobField, snapshot);
    if (action.kind === "none") continue;

    if (action.kind === "commitCrime") {
      if (!deferredCrime) {
        const crime = pickCrimeForKills(ns, config.minCrimeSuccessChance);
        if (crime) deferredCrime = { kind: "commitCrime", crime };
      }
      continue;
    }
    return action;
  }

  if (!deferredCrime) return { kind: "none" };
  if (!config.enableCrimeForKills) return { kind: "none" };
  if (decideEligibilityStandDown(state.crimeAttempts, config.maxCrimeAttempts)) {
    await log.warn(
      `[Faction] Standing down from crime-for-kills - ${state.crimeAttempts} attempts >= maxCrimeAttempts (${config.maxCrimeAttempts}). ` +
        `Edit ${STATE_PATH}'s crimeAttempts back down (or delete the file) once you're ready to try again.`
    );
    return { kind: "none" };
  }
  return deferredCrime;
}

/**
 * Only called when decideWorkTarget (existing, unchanged) returns
 * undefined - grinding reputation at an already-joined faction toward an
 * unowned augmentation always wins the single work slot. See
 * server_metadata.md for why this doesn't make the feature dead code:
 * with autoPurchaseAugmentations at its default false, reputation keeps
 * accumulating past every augmentation's repReq with nothing spent on
 * it, so decideWorkTarget legitimately returns undefined once every
 * joined faction's augmentations are rep-satisfied - a common steady
 * state, not a rare edge case. Company pursuit is tried before criminal
 * pursuit's own safe-then-risky ordering (see pursueCriminalFactions) -
 * company work is fully reversible via quitJob, so it's the least risky
 * new use of the work slot.
 */
async function decideEligibilityWorkSlotAction(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  state: FactionState,
  snapshot: EligibilitySnapshot,
  joinedFactions: string[]
): Promise<EligibilityAction> {
  if (config.pursueCompanyFactions) {
    const companyAction = pursueCompanyFactions(ns, config, snapshot, joinedFactions);
    if (companyAction.kind !== "none") return companyAction;
  }
  if (config.pursueCriminalFactions) {
    return await pursueCriminalFactions(ns, log, config, state, snapshot, joinedFactions);
  }
  return { kind: "none" };
}

/**
 * Generalizes isAlreadyWorking's discipline (never restart an
 * already-correct work action every tick) across every new action kind
 * that also claims the single work slot - workForCompany/gymWorkout/
 * commitCrime all cancel whatever's currently in progress when called
 * (confirmed in each function's own doc), same as workForFaction. travel
 * and quitJob don't touch the work slot at all, so they're always safe to
 * call, gated only by their own idempotency check (already-in-that-city /
 * always-safe-to-repeat respectively).
 *
 * Returns true if a commitCrime action actually executed (so tick() can
 * increment /var/faction_state.txt's crimeAttempts) - deliberately
 * counted per *call* (i.e. per time we actually told the game to start
 * committing this crime), not per individual crime completion inside
 * that run, since commitCrime (like workForFaction) keeps looping on its
 * own between ticks once started; that's a coarser circuit breaker than
 * literal kill attempts, but matches this codebase's existing
 * "bound how many times we resort to this" intent (see
 * gang_decisions.ts's decideStandDown).
 */
async function executeEligibilityAction(ns: NS, log: Logger, action: EligibilityAction, gymLocation: string): Promise<boolean> {
  const current = ns.singularity.getCurrentWork();

  switch (action.kind) {
    case "none":
      return false;

    case "travel":
      if (ns.getPlayer().city !== action.city && ns.singularity.travelToCity(action.city as CityNameType)) {
        await log.info(`[Faction] Traveled to ${action.city}.`);
      }
      return false;

    case "quitJob":
      ns.singularity.quitJob(action.company as CompanyNameType);
      await log.info(`[Faction] Quit job at ${action.company} to clear a criminal-faction requirement.`);
      return false;

    case "applyToCompany": {
      const job = ns.singularity.applyToCompany(action.company as CompanyNameType, action.field as JobFieldType);
      if (job) await log.info(`[Faction] Applied to ${action.company}, hired as ${job}.`);
      return false;
    }

    case "workForCompany":
      if (!(current?.type === "COMPANY" && current.companyName === action.company)) {
        if (ns.singularity.workForCompany(action.company as CompanyNameType)) {
          await log.info(`[Faction] Working for ${action.company} to build reputation toward its faction invite.`);
        }
      }
      return false;

    case "gymWorkout": {
      const gymType = ns.enums.GymType[action.stat];
      if (!(current?.type === "CLASS" && current.location === gymLocation && current.classType === gymType)) {
        if (ns.singularity.gymWorkout(gymLocation as GymLocationNameType, gymType)) {
          await log.info(`[Faction] Training ${action.stat} at ${gymLocation}.`);
        }
      }
      return false;
    }

    case "commitCrime":
      if (!(current?.type === "CRIME" && current.crimeType === action.crime)) {
        ns.singularity.commitCrime(action.crime as CrimeTypeType);
        await log.info(`[Faction] Committing ${action.crime} (targeting a criminal faction's numPeopleKilled requirement).`);
        return true;
      }
      return false;
  }
}

/**
 * Whether installing `pending` now reaches the GROW_STATS hacking goal
 * sooner than continuing to study (compareInstall's ratio at or under
 * growStatsInstallMaxRatio). Without Formulas.exe it can't tell, so no.
 */
async function growStatsInstallSaves(
  ns: NS,
  log: Logger,
  config: FactionConfig,
  player: ReturnType<NS["getPlayer"]>,
  pending: PendingBoost
): Promise<boolean> {
  if (!ns.fileExists("Formulas.exe", "home")) return false;
  const level = player.skills.hacking;
  const exp = player.exp.hacking;
  const mult = effectiveSkillMult(level, (m) => ns.formulas.skills.calculateSkill(exp, m));
  if (mult === undefined) return false;

  const goal = hackingGoal(config.growStatsHackingGoal, ns.serverExists(WORLD_DAEMON) ? ns.getServerRequiredHackingLevel(WORLD_DAEMON) : undefined);
  const boost = pending.multipliers;
  const c = compareInstall(goal, exp, mult, boost.hacking ?? 1, boost.hacking_exp ?? 1, (lvl, m) => ns.formulas.skills.calculateExp(lvl, m));
  const saves = c.ratio <= config.growStatsInstallMaxRatio;
  await log.debug(
    `[Faction] GROW_STATS install check: goal=${goal} level=${level} pending=${pending.count} ` +
      `level x${(boost.hacking ?? 1).toFixed(3)} exp x${(boost.hacking_exp ?? 1).toFixed(3)} ratio=${c.ratio.toFixed(2)} -> ${saves ? "install" : "hold"}`
  );
  return saves;
}

/** Whether scheduler_daemon.js's current approach is `approach`; false if the scheduler isn't reachable. */
async function schedulerApproachIs(ns: NS, approach: Approach): Promise<boolean> {
  const res = await NewSchedulerServiceClient(ns).GetSchedulerConfig({});
  return res.status === Codes.OK && (res.data?.config?.approach ?? Approach.HACK) === approach;
}

async function tick(ns: NS, log: Logger, config: FactionConfig): Promise<void> {
  const playerRes = await player_metadata_pb
    .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
    .GetPlayerMetadata({});
  const money = playerRes.data?.player?.money ?? 0;

  const invitations = ns.singularity.checkFactionInvitations();
  const toJoin = decideFactionsToJoin(invitations, ns.getPlayer().factions, config.joinAllowlist);
  for (const faction of toJoin) {
    if (ns.singularity.joinFaction(faction as FactionNameType)) await log.info(`[Faction] Joined ${faction}.`);
  }

  // Re-read rather than reuse the pre-join snapshot - joinFaction takes
  // effect immediately, so this reflects any joins from the loop above
  // within the same tick instead of waiting until next tick to see them.
  // Captured once as a full Player object - both `.factions` (as before)
  // and the eligibility snapshot below come from this single call.
  const player = ns.getPlayer();
  const joinedFactions = player.factions;

  const reps: Record<string, number> = joinedFactions.length > 0 ? gatherReps(ns, joinedFactions) : {};
  const catalog: AugmentationInfo[] = joinedFactions.length > 0 ? gatherCatalog(ns, joinedFactions) : [];
  const owned = ns.singularity.getOwnedAugmentations(true);
  const pending = getPendingAugmentations(ns);
  const pendingBoost: PendingBoost = {
    count: pending.length,
    multipliers: combineMultipliers(pending.map((name) => ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>)),
    writtenAt: Date.now(),
  };
  ns.write(PENDING_BOOST_PATH, JSON.stringify(pendingBoost), "w");

  // GROW_STATS (scheduler.proto) hands the player's work slot to
  // study_daemon.ts, so neither faction work nor eligibility work below
  // claims it - otherwise each would restart over the other every tick.
  const growingStats = await schedulerApproachIs(ns, Approach.GROW_STATS);

  // What's bought or donated for - narrowed during GROW_STATS.
  const buyCatalog = growingStats ? catalog.filter((aug) => matchesFocus(aug.stats, config.growStatsAugmentationFocus)) : catalog;

  const workTarget = !growingStats && joinedFactions.length > 0 ? decideWorkTarget(joinedFactions, reps, catalog, owned) : undefined;
  if (workTarget) {
    const workType = pickWorkType(ns, workTarget);
    if (workType && !isAlreadyWorking(ns, workTarget, workType)) {
      ns.singularity.workForFaction(workTarget as FactionNameType, workType as FactionWorkTypeType);
    }
  }

  // Active eligibility-seeking (full design in server_metadata.md) - runs
  // regardless of whether any faction is joined yet, since e.g. traveling
  // to a city or applying to a company is exactly how a fresh BitNode run
  // gets its FIRST faction, not just later ones.
  const snapshot = gatherEligibilitySnapshot(player);
  const state = loadState(ns);

  // Travel never touches the work slot, so it runs unconditionally
  // alongside whatever wins the work slot below - see pursueCityFactions'
  // own doc for the mutual-exclusivity short-circuit.
  // Also skipped during GROW_STATS: study_daemon.ts may need the player in
  // a different city (a university), and the two would travel back and forth.
  const cityAction: EligibilityAction = config.pursueCityFactions && !growingStats
    ? pursueCityFactions(ns, config, snapshot, joinedFactions)
    : { kind: "none" };
  await executeEligibilityAction(ns, log, cityAction, config.gymLocation);

  // Only tried when the work slot isn't already claimed by grinding rep
  // at an already-joined faction - see decideEligibilityWorkSlotAction's doc.
  const eligibilityAction: EligibilityAction =
    workTarget || growingStats
    ? { kind: "none" }
    : await decideEligibilityWorkSlotAction(ns, log, config, state, snapshot, joinedFactions);
  const crimeAttempted = await executeEligibilityAction(ns, log, eligibilityAction, config.gymLocation);
  if (crimeAttempted) {
    state.crimeAttempts += 1;
    saveState(ns, state);
  }

  const purchaseDecision: PurchaseDecision = config.autoPurchaseAugmentations
    ? decideAugmentationPurchase(money, config.reserveMoney, config.maxSpendFraction, reps, buyCatalog, owned)
    : { kind: "none" };

  await log.debug(
    `[Faction] tick: money=$${money.toFixed(0)} joined=${joinedFactions.length} workTarget=${workTarget ?? "none"} ` +
      `pending=${pending.length} purchase=${purchaseDecision.kind === "buy" ? purchaseDecision.augmentation : "none"} ` +
      `city=${cityAction.kind} eligibility=${eligibilityAction.kind} crimeAttempts=${state.crimeAttempts} growStats=${growingStats}`
  );

  if (joinedFactions.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  // Keeps an in-progress wind-down alive while its freed cash gets spent.
  const refreshWindDown = (): void => {
    if (readInstallPending(ns)) touchInstallPending(ns, now);
  };

  if (purchaseDecision.kind === "buy") {
    if (ns.singularity.purchaseAugmentation(purchaseDecision.faction as FactionNameType, purchaseDecision.augmentation)) {
      await log.info(`[Faction] Purchased ${purchaseDecision.augmentation} from ${purchaseDecision.faction}.`);
    }
    if (config.autoInstall) refreshWindDown();
    // Re-derive fresh state (including the new pending list) next tick
    // before even considering install - never buy and install same-tick.
    return;
  }

  // Nothing purchasable outright - try buying the missing reputation with
  // money (decideDonation). The augmentation itself is bought next tick by
  // the normal purchase path above.
  const donatable =
    config.autoPurchaseAugmentations && config.autoDonate && ns.fileExists("Formulas.exe", "home")
      ? donatableFactions(ns, joinedFactions, playerRes.data?.player?.gangAvailable === true)
      : new Set<string>();
  // 0.1% over the exact amount, so float rounding can't leave the rep a
  // hair short of the requirement.
  const donationForRep = (rep: number): number => Math.ceil(ns.formulas.reputation.donationForRep(rep, player) * 1.001);
  const decideDonationWith = (reserveMoney: number, maxSpendFraction: number): DonationDecision =>
    donatable.size > 0
      ? decideDonation(money, reserveMoney, maxSpendFraction, reps, buyCatalog, owned, donatable, donationForRep)
      : { kind: "none" };

  const donation = decideDonationWith(config.reserveMoney, config.donationSpendFraction);
  if (donation.kind === "donate") {
    await executeDonation(ns, log, donation);
    if (config.autoInstall) refreshWindDown();
    return;
  }

  // During GROW_STATS an install resets the hacking experience being
  // studied up, so it only goes ahead when the pending augmentations'
  // multipliers more than make up for it (see growStatsInstallSaves).
  const installReady = config.autoInstall && decideInstallReady(purchaseDecision, pending);
  const growStatsBlocks = installReady && growingStats && !(await growStatsInstallSaves(ns, log, config, player, pendingBoost));
  if (!installReady || growStatsBlocks) {
    if (readInstallPending(ns)) {
      clearInstallPending(ns);
      await log.info(
        `[Faction] Install no longer ready (autoInstall off, or not worth it during GROW_STATS) - cancelling the wind-down; stock trading resumes.`
      );
    }
    return;
  }

  // Everything left is spent before the install wipes cash and stock - see
  // decidePreInstall and development/libraries/install_handshake.ts.
  const finalPurchase: PurchaseDecision = config.autoPurchaseAugmentations
    ? decideAugmentationPurchase(money, 0, 1, reps, buyCatalog, owned)
    : { kind: "none" };
  if (finalPurchase.kind === "none") {
    // Same whole-balance rule as finalPurchase: the install is about to
    // wipe this cash, so rep bought now is the last thing it can become.
    const finalDonation = decideDonationWith(0, 1);
    if (finalDonation.kind === "donate") {
      await executeDonation(ns, log, finalDonation);
      refreshWindDown();
      return;
    }
  }
  const heldPositions = stockPositionsHeld(ns);
  const action = decidePreInstall(finalPurchase, heldPositions);

  if (action.kind === "buy") {
    if (ns.singularity.purchaseAugmentation(action.faction as FactionNameType, action.augmentation)) {
      await log.info(`[Faction] Pre-install: purchased ${action.augmentation} from ${action.faction} with the remaining cash.`);
    }
    refreshWindDown();
    return;
  }

  if (action.kind === "wind-down") {
    const starting = !readInstallPending(ns);
    touchInstallPending(ns, now);
    if (starting) {
      await log.info(
        `[Faction] Install ready, but ${heldPositions} stock position(s) are still held and an install deletes them with no refund. ` +
          "Asking stock_daemon.js to sell everything; the cash will be spent on augmentations before installing."
      );
    } else {
      await log.debug(`[Faction] Wind-down: waiting on stock_daemon.js to sell ${heldPositions} position(s).`);
    }
    return;
  }

  clearInstallPending(ns);
  await log.info(`[Faction] Installing ${pending.length} augmentation(s) and rebooting into ${config.bootScript}...`);
  ns.singularity.installAugmentations(config.bootScript);
}

/**
 * Joined factions that accept donations: favor >= getFavorToDonate(), and
 * never the gang's own faction (donateToFaction always refuses it). The gang
 * check is skipped entirely without Source-File 2, where ns.gang would throw.
 */
function donatableFactions(ns: NS, joinedFactions: string[], gangAvailable: boolean): Set<string> {
  const threshold = ns.getFavorToDonate();
  const gangFaction = gangAvailable && ns.gang.inGang() ? ns.gang.getGangInformation().faction : undefined;
  return new Set(
    joinedFactions.filter((faction) => faction !== gangFaction && ns.singularity.getFactionFavor(faction as FactionNameType) >= threshold)
  );
}

async function executeDonation(ns: NS, log: Logger, donation: { faction: string; augmentation: string; amount: number }): Promise<void> {
  const amount = `$${(donation.amount / 1e9).toFixed(2)}B`;
  if (ns.singularity.donateToFaction(donation.faction as FactionNameType, donation.amount)) {
    await log.info(`[Faction] Donated ${amount} to ${donation.faction} to cover the reputation for ${donation.augmentation}.`);
  } else {
    await log.warn(`[Faction] Donation of ${amount} to ${donation.faction} (for ${donation.augmentation}) was refused.`);
  }
}

/** Symbols with any shares held, long or short. 0 without TIX API access - every other ns.stock call needs it. */
function stockPositionsHeld(ns: NS): number {
  if (!ns.stock.hasTixApiAccess()) return 0;
  return ns.stock.getSymbols().filter((sym) => {
    const [long, , short] = ns.stock.getPosition(sym);
    return long > 0 || short > 0;
  }).length;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so every tick's reasoning is visible, same as hacknet_daemon.ts/
  // purchased_server_daemon.ts/scheduler_daemon.ts.
  const log = createLogger(ns, "Faction", LOG_LEVEL.DEBUG);

  await log.info("=== Faction manager online ===");

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      await tick(ns, log, config);
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
