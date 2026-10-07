import { NS } from "@ns";
import { loadJsonConfig } from "system/config";
import {
  CONFIG_PATH as FACTION_CONFIG_PATH,
  DEFAULT_CONFIG as FACTION_DEFAULT_CONFIG,
} from "factions/faction_daemon";
import { gatherCatalog, gatherReps, getPendingAugmentations } from "factions/faction_game_ns";
import {
  catalogsFor,
  decideAugmentationPurchase,
  decideDonation,
  decideInstallReady,
  NEUROFLUX_GOVERNOR,
  usefulCatalog,
} from "factions/faction_decisions";
import {
  CONFIG_PATH as GANG_CONFIG_PATH,
  DEFAULT_CONFIG as GANG_DEFAULT_CONFIG,
  loadState as loadGangState,
} from "gang/gang_daemon";
import { decideStandDown } from "gang/gang_decisions";

/**
 * One-shot decision-support dump for "should we install augmentations
 * yet?" - the fourth file allowed to reference ns.singularity (after
 * hacking/program_shopper.ts, backdoor_daemon.ts, faction_daemon.ts),
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

  // Donating money for reputation (ns.singularity.donateToFaction) needs
  // favor >= getFavorToDonate(). Favor only grows at install time, by
  // getFactionFavorGain() - the rep earned this run, converted. The gang's
  // own faction can never take donations.
  const favorToDonate = ns.getFavorToDonate();
  const gangFaction = ns.gang.inGang() ? ns.gang.getGangInformation().faction : undefined;

  lines.push(`=== Joined factions (donations need favor >= ${favorToDonate.toFixed(0)}) ===`);
  if (joinedFactions.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const faction of joinedFactions) {
      const favor = ns.singularity.getFactionFavor(faction);
      const gain = ns.singularity.getFactionFavorGain(faction);
      const donation =
        faction === gangFaction
          ? "gang faction - no donations"
          : favor >= favorToDonate
            ? "CAN DONATE NOW"
            : favor + gain >= favorToDonate
              ? "can donate after next install"
              : `needs ${(favorToDonate - favor - gain).toFixed(0)} more favor beyond next install`;
      lines.push(
        `${faction}: rep=${(reps[faction] ?? 0).toFixed(0)} favor=${favor.toFixed(0)} (+${gain.toFixed(0)} at next install) -> ${donation}`
      );
    }
  }
  lines.push("");

  // Same donatable set and cost function faction_daemon.ts uses (see its
  // donatableFactions / donationForRep), so the numbers below match what it
  // would actually do.
  const donatable = new Set<string>(
    joinedFactions.filter((f) => f !== gangFaction && ns.singularity.getFactionFavor(f) >= favorToDonate)
  );
  const hasFormulas = ns.fileExists("Formulas.exe", "home");
  const donationForRep = (rep: number): number => Math.ceil(ns.formulas.reputation.donationForRep(rep, player) * 1.001);

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
          // Hacking level and experience multipliers - what the push to
          // w0r1d_d43m0n's level needs (see skill_progress.ts).
          `hacking=x${(aug.stats?.hacking ?? 1).toFixed(3)} hacking_exp=x${(aug.stats?.hacking_exp ?? 1).toFixed(3)} ` +
          `rep=${currentRep.toFixed(0)}/${aug.repReq.toFixed(0)} (${repMet ? "OK" : "SHORT"}) ` +
          `prereqs=${missingPrereqs.length === 0 ? "OK" : `MISSING (${missingPrereqs.join(", ")})`} ` +
          `affordable=${affordable ? "YES" : "no"}` +
          (!repMet && hasFormulas && donatable.has(aug.faction)
            ? ` donate-to-unlock=$${(donationForRep(aug.repReq - currentRep) / 1e9).toFixed(1)}B`
            : "")
      );
    }
  }
  lines.push("");

  const pending = getPendingAugmentations(ns);
  lines.push(`=== Pending (bought, not yet installed): ${pending.length} ===`);
  if (pending.length > 0) lines.push(pending.join(", "));
  lines.push("");

  // The daemon's regular buying never includes NeuroFlux (catalogsFor) -
  // this used to predict "buy NeuroFlux Governor" the daemon wouldn't make.
  // Still approximate: AUGMENTS mode's priority focus and savings aren't
  // modeled here; the faction daemon's log is authoritative.
  const regular = catalogsFor(usefulCatalog(catalog, [...factionConfig.usefulAugmentationStats, ...factionConfig.secondaryAugmentationStats]), owned).regular;
  const purchaseDecision = decideAugmentationPurchase(
    player.money,
    factionConfig.reserveMoney,
    factionConfig.maxSpendFraction,
    reps,
    regular,
    owned
  );
  const installReady = decideInstallReady(purchaseDecision, pending, factionConfig.reserveMoney);

  lines.push("=== What faction_daemon.ts would decide right now ===");
  lines.push(`purchase -> ${purchaseDecision.kind === "buy" ? `buy ${purchaseDecision.augmentation} from ${purchaseDecision.faction}` : "none"}`);
  const donationDecision =
    purchaseDecision.kind === "none" && hasFormulas && factionConfig.autoDonate && donatable.size > 0
      ? decideDonation(player.money, factionConfig.reserveMoney, factionConfig.donationSpendFraction, reps, regular, owned, donatable, donationForRep)
      : { kind: "none" as const };
  lines.push(
    `donation -> ${
      donationDecision.kind === "donate"
        ? `donate $${(donationDecision.amount / 1e9).toFixed(2)}B to ${donationDecision.faction} for ${donationDecision.augmentation}`
        : "none (nothing affordable within the spend budget, or no donatable faction)"
    }`
  );
  lines.push(`installReady -> ${installReady && donationDecision.kind === "none"} (autoPurchaseAugmentations=${factionConfig.autoPurchaseAugmentations}, autoInstall=${factionConfig.autoInstall}, autoDonate=${factionConfig.autoDonate})`);
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
  // --out <file>: the same report as a file, for build/bridge.mjs to copy out.
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0 && typeof ns.args[outIdx + 1] === "string") ns.write(ns.args[outIdx + 1] as string, lines.join("\n"), "w");
}
