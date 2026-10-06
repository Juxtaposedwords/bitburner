import { NS } from "@ns";

const RED_PILL = "The Red Pill";
const WORLD_DAEMON = "w0r1d_d43m0n";
const BOOT_SCRIPT = "boot.js";
// Every decision is also written here (the terminal isn't visible to tools).
const REPORT_PATH = "/var/claude_out/finish_bitnode.txt";

/**
 * Finishes the current BitNode and starts the next one, running boot.js
 * there:
 *
 *   run tools/finish_bitnode.js <next BitNode> --confirm
 *
 * The one deliberate exit - backdoor_daemon.ts never touches w0r1d_d43m0n,
 * so a BitNode kept on purpose (BN10 for Covenant sleeves) can't end by
 * accident. Checks first: The Red Pill installed (not just bought) and
 * hacking at w0r1d_d43m0n's requirement; without --confirm it only reports.
 */
export async function main(ns: NS): Promise<void> {
  const say = (line: string): void => {
    ns.tprint(line);
    ns.write(REPORT_PATH, `[${new Date().toISOString()}] ${line}\n`, "a");
  };
  const next = Number(ns.args[0]);
  const confirmed = ns.args.includes("--confirm");
  if (!Number.isInteger(next) || next < 1 || next > 14) {
    say("usage: run tools/finish_bitnode.js <next BitNode 1-14> --confirm");
    return;
  }
  const installed = ns.singularity.getOwnedAugmentations(false).includes(RED_PILL);
  const visible = ns.serverExists(WORLD_DAEMON);
  const required = visible ? ns.getServerRequiredHackingLevel(WORLD_DAEMON) : undefined;
  const level = ns.getHackingLevel();
  const report = `Red Pill installed: ${installed}; w0r1d_d43m0n: ${visible ? `needs hacking ${required}, have ${level}` : "not visible"}`;
  if (!installed || !visible || required === undefined || level < required) {
    say(`[FinishBitNode] Not ready - ${report}.`);
    return;
  }
  if (!confirmed) {
    say(`[FinishBitNode] Ready (${report}). Re-run with --confirm to destroy it and start BitNode ${next}.`);
    return;
  }
  say(`[FinishBitNode] Destroying ${WORLD_DAEMON}; starting BitNode ${next} with ${BOOT_SCRIPT} (${report}, root ${ns.hasRootAccess(WORLD_DAEMON)}).`);
  try {
    ns.singularity.destroyW0r1dD43m0n(next, BOOT_SCRIPT);
  } catch (e) {
    say(`[FinishBitNode] destroyW0r1dD43m0n failed: ${String(e)}`);
    return;
  }
  // Still here: the game didn't end the BitNode.
  say("[FinishBitNode] destroyW0r1dD43m0n returned without ending the BitNode.");
}
