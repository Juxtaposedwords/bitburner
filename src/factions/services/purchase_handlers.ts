import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["purchaseAugmentation"]>[0];

// Home RAM upgrades one UpgradeHomeRam call buys at most.
const MAX_HOME_RAM_UPGRADES = 50;

/** Stock positions held, long or short; 0 without TIX API access (the other ns.stock calls need it). */
function positionsHeld(ns: NS): number {
  if (!ns.stock.hasTixApiAccess()) return 0;
  return ns.stock.getSymbols().filter((sym) => {
    const [long, , short] = ns.stock.getPosition(sym);
    return long > 0 || short > 0;
  }).length;
}

/**
 * AugmentPurchaseService (faction_services.proto): spending before an
 * install, and the install itself.
 */
export function createPurchaseHandlers(ns: NS): fs_pb.AugmentPurchaseServiceHandlers {
  return {
    Snapshot: () => ({ homeRamCost: ns.singularity.getUpgradeHomeRamCost(), positionsHeld: positionsHeld(ns) }),
    Purchase: (req) => ({ ok: ns.singularity.purchaseAugmentation(req.faction as FactionNameType, req.augmentation ?? ""), detail: "" }),
    Donate: (req) => ({ ok: ns.singularity.donateToFaction(req.faction as FactionNameType, req.amount ?? 0), detail: "" }),
    UpgradeHomeRam: () => {
      const costs: number[] = [];
      for (let i = 0; i < MAX_HOME_RAM_UPGRADES; i++) {
        const cost = ns.singularity.getUpgradeHomeRamCost();
        if (!(cost <= ns.getServerMoneyAvailable("home")) || !ns.singularity.upgradeHomeRam()) break;
        costs.push(cost);
      }
      return { costs, ramAfter: ns.getServerMaxRam("home") };
    },
    Install: (req) => {
      ns.singularity.installAugmentations(req.bootScript ?? "boot.js");
      return { ok: true, detail: "" };
    },
  };
}
