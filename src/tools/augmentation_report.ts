import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import {
  CONFIG_PATH as FACTION_CONFIG_PATH,
  DEFAULT_CONFIG as FACTION_DEFAULT_CONFIG,
  gatherCatalog,
  gatherReps,
  getPendingAugmentations,
} from "development/metadata/faction_daemon";
import { decideAugmentationPurchase, decideInstallReady, NEUROFLUX_GOVERNOR } from "development/metadata/faction_decisions";
import {
  CONFIG_PATH as GANG_CONFIG_PATH,
  DEFAULT_CONFIG as GANG_DEFAULT_CONFIG,
  loadState as loadGangState,
} from "development/metadata/gang_daemon";
import { decideStandDown } from "development/metadata/gang_decisions";

/**
 * One-shot decision-support dump for "should we install augmentations
 * yet?" - the fourth file allowed to reference ns.singularity (after
 * tools/program_shopper.ts, backdoor_daemon.ts, faction_daemon.ts),
 * isolated automatically by being its own standalone script, same as
 * tools/check_cloud.ts is for ns.cloud.
 *
 * Reuses faction_daemon.ts's (and gang_daemon.ts's) own gather/decide
 * exports rather than re-deriving anything, so this report can never
 * drift out of sync with what the daemons actually do - the "what would
 * happen right now" lines are the live decisions, not separate judgment
 * calls. All output goes through a single ns.tprint call (accumulated
 * lines, one join) rather than one tprint per line - the same fix
 * already applied to tools/scan.ts, since Bitburner prefixes every
 * separate tprint call with the script's filename.
 */
export async function main(ns: NS): Promise<void> {
  const lines: string[] = [];

  const player = ns.getPlayer();
  lines.push("=== Reset stakes (what installAugmentations wipes) ===");
  lines.push(`money=$${player.money.toFixed(0)} hackingLevel=${player.skills.hacking} hacknetNodes=${ns.hacknet.numNodes()}`);
  lines.push("");

  const factionConfig = loadJsonConfig(ns, FACTION_CONFIG_PATH, FACTION_DEFAULT_CONFIG);
  const joinedFactions = player.factions;
  const reps = gatherReps(ns, joinedFactions);

  lines.push("=== Joined factions ===");
  if (joinedFactions.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const faction of joinedFactions) lines.push(`${faction}: rep=${(reps[faction] ?? 0).toFixed(0)}`);
  }
  lines.push("");

  const catalog = gatherCatalog(ns, joinedFactions);
  const owned = ns.singularity.getOwnedAugmentations(true);
  const ownedSet = new Set(owned);
  const notOwned = catalog.filter((aug) => aug.name === NEUROFLUX_GOVERNOR || !ownedSet.has(aug.name));

  lines.push(`=== Augmentation catalog (${notOwned.length} not-yet-owned, of ${catalog.length} offered) ===`);
  if (notOwned.length === 0) {
    lines.push("(nothing left to buy from any joined faction)");
  } else {
    for (const aug of notOwned) {
      const currentRep = reps[aug.faction] ?? 0;
      const repMet = currentRep >= aug.repReq;
      const missingPrereqs = aug.prereqs.filter((p) => !ownedSet.has(p));
      const affordable = aug.price <= player.money;
      lines.push(
        `${aug.name} [${aug.faction}] price=$${aug.price.toFixed(0)} ` +
          `rep=${currentRep.toFixed(0)}/${aug.repReq.toFixed(0)} (${repMet ? "OK" : "SHORT"}) ` +
          `prereqs=${missingPrereqs.length === 0 ? "OK" : `MISSING (${missingPrereqs.join(", ")})`} ` +
          `affordable=${affordable ? "YES" : "no"}`
      );
    }
  }
  lines.push("");

  const pending = getPendingAugmentations(ns);
  lines.push(`=== Pending (bought, not yet installed): ${pending.length} ===`);
  if (pending.length > 0) lines.push(pending.join(", "));
  lines.push("");

  const purchaseDecision = decideAugmentationPurchase(
    player.money,
    factionConfig.reserveMoney,
    factionConfig.maxSpendFraction,
    reps,
    catalog,
    owned
  );
  const installReady = decideInstallReady(purchaseDecision, pending);

  lines.push("=== What faction_daemon.ts would decide right now ===");
  lines.push(`purchase -> ${purchaseDecision.kind === "buy" ? `buy ${purchaseDecision.augmentation} from ${purchaseDecision.faction}` : "none"}`);
  lines.push(`installReady -> ${installReady} (autoPurchaseAugmentations=${factionConfig.autoPurchaseAugmentations}, autoInstall=${factionConfig.autoInstall})`);
  lines.push("");

  if (ns.gang.inGang()) {
    const gangConfig = loadJsonConfig(ns, GANG_CONFIG_PATH, GANG_DEFAULT_CONFIG);
    const gang = ns.gang.getGangInformation();
    const gangState = loadGangState(ns);
    const standDown = decideStandDown(gangState.casualties, gangConfig.maxCasualties);

    lines.push("=== Gang status (unaffected by installAugmentations, aside from a small per-member ascension-point penalty) ===");
    lines.push(
      `members=${ns.gang.getMemberNames().length} respect=${gang.respect.toFixed(0)} power=${gang.power.toFixed(2)} ` +
        `territory=${(gang.territory * 100).toFixed(1)}% wantedPenalty=${gang.wantedPenalty.toFixed(3)} posture=${gangConfig.posture} ` +
        `casualties=${gangState.casualties} standDown=${standDown}`
    );
  } else {
    lines.push("=== Gang status === (not in a gang)");
  }

  ns.tprint(lines.join("\n"));
}
