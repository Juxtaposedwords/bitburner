import { NS } from "@ns";
import * as pb from "factions/rpc/install";

/** Stock positions held, long or short; 0 without TIX API access (the other ns.stock calls need it). */
function positionsHeld(ns: NS): number {
  if (!ns.stock.hasTixApiAccess()) return 0;
  return ns.stock.getSymbols().filter((sym) => {
    const [long, , short] = ns.stock.getPosition(sym);
    return long > 0 || short > 0;
  }).length;
}

/** InstallService: what an install would lose (stock positions), and the install itself. */
export function createInstallHandlers(ns: NS): pb.InstallServiceHandlers {
  return {
    GetInstallState: () => ({ positionsHeld: positionsHeld(ns) }),
    Install: (req) => {
      ns.singularity.installAugmentations(req.bootScript ?? "boot.js");
      return { ok: true };
    },
  };
}
