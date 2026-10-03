import { NS } from "@ns";
import { getPendingAugmentations } from "development/metadata/faction_daemon";

const BOOT_SCRIPT = "boot.js";

/**
 * Installs pending augmentations right now, the safe way:
 *
 *   run tools/install_now.js
 *
 * Sells every stock position first (an install deletes them with no
 * refund), then installs and relaunches boot.js - what the faction
 * daemon's own wind-down does, minus waiting. Refuses with nothing pending
 * (the game won't install then anyway).
 */
export async function main(ns: NS): Promise<void> {
  const pending = getPendingAugmentations(ns);
  if (pending.length === 0) {
    ns.tprint("[InstallNow] Nothing pending - nothing to install.");
    return;
  }

  let sold = 0;
  if (ns.stock.hasTixApiAccess()) {
    for (const sym of ns.stock.getSymbols()) {
      const [long, , short] = ns.stock.getPosition(sym);
      if (long > 0 && ns.stock.sellStock(sym, long) > 0) sold++;
      if (short > 0 && ns.stock.sellShort(sym, short) > 0) sold++;
    }
  }

  ns.tprint(`[InstallNow] Sold ${sold} stock position(s); installing ${pending.length} augmentation(s): ${pending.join(", ")}.`);
  ns.singularity.installAugmentations(BOOT_SCRIPT);
}
