import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import {
  AugmentationInfo,
  decideAugmentationPurchase,
  decideFactionsToJoin,
  decideInstallReady,
  decideWorkTarget,
  PurchaseDecision,
} from "development/metadata/faction_decisions";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

// FactionName/FactionWorkType are big string-literal unions not exported
// by name from "@ns" - pulled out structurally the same way
// hacknet_daemon.ts derives HashUpgradeName, rather than duplicating the
// literal list here. Our own decision logic treats faction names/work
// types as plain strings throughout (see faction_decisions.ts) since it
// has no `ns` dependency; these casts are only needed at the boundary
// where a plain string crosses back into an ns.singularity.* call.
type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];
type FactionWorkTypeType = Parameters<NS["singularity"]["workForFaction"]>[1];

/**
 * The third file allowed to import ns.singularity (after
 * tools/program_shopper.ts and backdoor_daemon.ts) - kept isolated for the
 * same RAM-cost reason (see server_metadata.md). Only launched by boot.ts
 * when PlayerMetadata.singularityAvailable is true. (A fourth,
 * tools/augmentation_report.ts, reuses this file's own gather/decide
 * exports rather than re-deriving anything - see its module doc.)
 *
 * No RPC service of its own, and no persisted state of its own either:
 * like hacknet_daemon.ts's node stats, faction reputation/augmentation
 * state is cheap to re-derive fresh from ns.singularity.* every tick, and
 * so is membership itself - ns.getPlayer().factions is the live, current
 * list (an earlier version of this file mistakenly persisted its own
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
  // Script to relaunch into after installAugmentations wipes everything.
  bootScript: string;
};

export const DEFAULT_CONFIG: FactionConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  autoPurchaseAugmentations: false,
  autoInstall: false,
  bootScript: "boot.js",
};

export const CONFIG_PATH = "/etc/faction.txt";
const TICK_INTERVAL_MS = 5000;

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
  const joinedFactions = ns.getPlayer().factions;
  if (joinedFactions.length === 0) return;

  const reps = gatherReps(ns, joinedFactions);
  const catalog = gatherCatalog(ns, joinedFactions);
  const owned = ns.singularity.getOwnedAugmentations(true);
  const pending = getPendingAugmentations(ns);

  const workTarget = decideWorkTarget(joinedFactions, reps, catalog, owned);
  if (workTarget) {
    const workType = pickWorkType(ns, workTarget);
    if (workType && !isAlreadyWorking(ns, workTarget, workType)) {
      ns.singularity.workForFaction(workTarget as FactionNameType, workType as FactionWorkTypeType);
    }
  }

  const purchaseDecision: PurchaseDecision = config.autoPurchaseAugmentations
    ? decideAugmentationPurchase(money, config.reserveMoney, config.maxSpendFraction, reps, catalog, owned)
    : { kind: "none" };

  await log.debug(
    `[Faction] tick: money=$${money.toFixed(0)} joined=${joinedFactions.length} workTarget=${workTarget ?? "none"} ` +
      `pending=${pending.length} purchase=${purchaseDecision.kind === "buy" ? purchaseDecision.augmentation : "none"}`
  );

  if (purchaseDecision.kind === "buy") {
    if (ns.singularity.purchaseAugmentation(purchaseDecision.faction as FactionNameType, purchaseDecision.augmentation)) {
      await log.info(`[Faction] Purchased ${purchaseDecision.augmentation} from ${purchaseDecision.faction}.`);
    }
    // Re-derive fresh state (including the new pending list) next tick
    // before even considering install - never buy and install same-tick.
    return;
  }

  if (config.autoInstall && decideInstallReady(purchaseDecision, pending)) {
    await log.info(`[Faction] Installing ${pending.length} augmentation(s) and rebooting into ${config.bootScript}...`);
    ns.singularity.installAugmentations(config.bootScript);
  }
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
