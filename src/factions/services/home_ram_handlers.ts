import { NS } from "@ns";
import * as pb from "factions/rpc/home_ram";

// Home RAM upgrades one UpgradeHomeRam call buys at most.
const MAX_HOME_RAM_UPGRADES = 50;

/** HomeRamService: buying home RAM while cash covers it. */
export function createHomeRamHandlers(ns: NS): pb.HomeRamServiceHandlers {
  return {
    UpgradeHomeRam: () => {
      const costs: number[] = [];
      for (let i = 0; i < MAX_HOME_RAM_UPGRADES; i++) {
        const cost = ns.singularity.getUpgradeHomeRamCost();
        if (!(cost <= ns.getServerMoneyAvailable("home")) || !ns.singularity.upgradeHomeRam()) break;
        costs.push(cost);
      }
      return { costs, ramAfter: ns.getServerMaxRam("home") };
    },
  };
}
