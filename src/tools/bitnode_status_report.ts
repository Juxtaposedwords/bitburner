import { NS } from "@ns";

/**
 * One-shot readiness check for actually finishing the BitNode - not just
 * "are we growing," but "how far from the real finish line."
 * w0r1d_d43m0n is excluded from the network entirely until "The Red
 * Pill" is installed (confirmed in Bitburner's own ServerHelpers.ts);
 * The Red Pill comes from the Daedalus faction, whose invite
 * requirements (confirmed in FactionInfo.tsx) are 30 installed
 * augmentations (BitNodeMultipliers.DaedalusAugsRequirement's default -
 * not confirmed whether BN9 overrides it), $100B, and either hacking
 * level 2500 or every combat stat at 1500.
 *
 * The fifth file allowed to reference ns.singularity (after
 * program_shopper.ts, backdoor_daemon.ts, faction_daemon.ts,
 * tools/augmentation_report.ts) - isolated automatically by being its
 * own standalone script, same as check_cloud.ts is for ns.cloud.
 */
type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];

const DAEDALUS = "Daedalus" as FactionNameType;
const RED_PILL = "The Red Pill";
const WORLD_DAEMON = "w0r1d_d43m0n";

const DAEDALUS_AUGS_REQUIREMENT = 30;
const DAEDALUS_MONEY_REQUIREMENT = 100e9;
const DAEDALUS_HACKING_REQUIREMENT = 2500;
const DAEDALUS_COMBAT_REQUIREMENT = 1500;

export async function main(ns: NS): Promise<void> {
  const lines: string[] = [];
  const player = ns.getPlayer();

  const installedAugs = ns.singularity.getOwnedAugmentations(false).length;
  const inDaedalus = player.factions.includes(DAEDALUS);
  const invitedToDaedalus = ns.singularity.checkFactionInvitations().includes(DAEDALUS);
  const combatReady =
    player.skills.strength >= DAEDALUS_COMBAT_REQUIREMENT &&
    player.skills.defense >= DAEDALUS_COMBAT_REQUIREMENT &&
    player.skills.dexterity >= DAEDALUS_COMBAT_REQUIREMENT &&
    player.skills.agility >= DAEDALUS_COMBAT_REQUIREMENT;
  const hackingReady = player.skills.hacking >= DAEDALUS_HACKING_REQUIREMENT;

  lines.push("=== Daedalus readiness (source of The Red Pill) ===");
  lines.push(`joined=${inDaedalus} invited=${invitedToDaedalus}`);
  lines.push(
    `installedAugmentations=${installedAugs}/${DAEDALUS_AUGS_REQUIREMENT} ` +
      `${installedAugs >= DAEDALUS_AUGS_REQUIREMENT ? "OK" : "SHORT"} (BN9's actual multiplier unconfirmed - default assumed)`
  );
  lines.push(
    `money=$${player.money.toFixed(0)}/$${DAEDALUS_MONEY_REQUIREMENT.toFixed(0)} ` +
      `${player.money >= DAEDALUS_MONEY_REQUIREMENT ? "OK" : "SHORT"}`
  );
  lines.push(
    `hackingLevel=${player.skills.hacking}/${DAEDALUS_HACKING_REQUIREMENT} ${hackingReady ? "OK" : "SHORT"} ` +
      `(OR every combat stat >= ${DAEDALUS_COMBAT_REQUIREMENT}: str=${player.skills.strength} def=${player.skills.defense} ` +
      `dex=${player.skills.dexterity} agi=${player.skills.agility} -> ${combatReady ? "OK" : "SHORT"})`
  );
  lines.push("");

  const hasRedPill = ns.singularity.getOwnedAugmentations(true).includes(RED_PILL);
  const redPillInstalled = ns.singularity.getOwnedAugmentations(false).includes(RED_PILL);
  const worldDaemonVisible = ns.serverExists(WORLD_DAEMON);

  lines.push("=== w0r1d_d43m0n (the actual finish line) ===");
  lines.push(`theRedPill: owned=${hasRedPill} installed=${redPillInstalled} (must be INSTALLED, not just bought, to reveal the server)`);
  lines.push(`serverVisible=${worldDaemonVisible}`);
  if (worldDaemonVisible) {
    const wd = ns.getServer(WORLD_DAEMON);
    lines.push(`rooted=${wd.hasAdminRights} requiredHackingSkill=${wd.requiredHackingSkill} (you: ${player.skills.hacking})`);
  }
  lines.push("");
  lines.push(
    "NOTE: nothing in this codebase calls ns.singularity.destroyW0r1dD43m0n() yet - once serverVisible && rooted, " +
      "that final call still needs to happen (manually, or via new automation)."
  );

  ns.tprint(lines.join("\n"));
}
