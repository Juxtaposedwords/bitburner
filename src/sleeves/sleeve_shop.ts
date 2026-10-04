import { NS } from "@ns";
import { loadJsonConfig } from "system/config";
import { readBitNodeInfo } from "system/bitnode_info";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import { effectiveReserve, readSavings } from "system/savings";
import { SLEEVE_SAVINGS_REASON } from "factions/faction_decisions";
import {
  CONFIG_PATH,
  COVENANT,
  decideSleeveInvestment,
  DEFAULT_CONFIG,
  pickSleeveAug,
  SLEEVE_SHOP_PATH,
  SleeveConfig,
  SleevesFile,
  SleeveShopFile,
} from "sleeves/sleeve_decisions";

/**
 * One pass of sleeve buying, run by sleeve_daemon.ts every minute when
 * there's RAM for it: Covenant sleeves and memory (BitNode 10 only), then
 * sleeve augmentations (any BitNode). Writes SLEEVE_SHOP_PATH for the
 * daemon and status. A separate script because these calls cost ~30 GB -
 * resident in the daemon they made it 96 GB, too big for BN12's fresh
 * 256 GB home, so seven sleeves sat idle.
 */
// Memory upgrades bought per tick at most, re-deciding after each.
const MAX_MEMORY_UPGRADES_PER_TICK = 20;
// Sleeve augmentations bought per tick at most, re-deciding after each.
const MAX_SLEEVE_AUGS_PER_TICK = 20;
// getAugmentationStats results never change - cached by name.
const augStatsCache = new Map<string, Record<string, number>>();

/**
 * Buys sleeve augmentations (pickSleeveAug): the cheapest useful one each
 * round, within investSpendFraction of cash above the savings target,
 * after this tick's sleeve and memory purchases. Any BitNode with sleeves.
 */
export async function buySleeveAugs(ns: NS, log: Logger, config: SleeveConfig): Promise<void> {
  const statsOf = (name: string): Record<string, number> => {
    let stats = augStatsCache.get(name);
    if (!stats) {
      stats = ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>;
      augStatsCache.set(name, stats);
    }
    return stats;
  };
  for (let i = 0; i < MAX_SLEEVE_AUGS_PER_TICK; i++) {
    const budget = Math.max(0, ns.getServerMoneyAvailable("home") - effectiveReserve(0, readSavings(ns))) * config.investSpendFraction;
    const options = Array.from({ length: ns.sleeve.getNumSleeves() }, (_, index) => {
      const shock = ns.sleeve.getSleeve(index).shock;
      return ns.sleeve.getSleevePurchasableAugs(index).map((aug) => ({ index, name: aug.name, cost: aug.cost, stats: statsOf(aug.name), shock }));
    }).flat();
    const pick = pickSleeveAug(options, budget);
    if (!pick) return;
    if (!ns.sleeve.purchaseSleeveAug(pick.index, pick.name)) {
      await log.warn(`[Sleeve] Couldn't buy ${pick.name} for sleeve ${pick.index}.`);
      return;
    }
    await log.info(`[Sleeve] Bought ${pick.name} for sleeve ${pick.index} ($${(pick.cost / 1e9).toFixed(2)}B).`);
  }
}

// The game's last answer to purchaseSleeve - logged only when it changes
// (kept in SLEEVE_SHOP_PATH between runs).
let lastSleeveMessage: string | undefined;

/**
 * BitNode 10: buy a sleeve from The Covenant and upgrade memory, within
 * investSpendFraction of cash above the savings target. Returns what the
 * status file shows about it, or undefined outside BitNode 10.
 */
export async function investInSleeves(ns: NS, log: Logger, config: SleeveConfig, node: number | undefined, factions: string[]): Promise<SleevesFile["shop"]> {
  if (node !== 10) return undefined;
  const covenantMember = factions.includes(COVENANT);
  for (let i = 0; i < MAX_MEMORY_UPGRADES_PER_TICK; i++) {
    const money = ns.getServerMoneyAvailable("home");
    const savings = readSavings(ns);
    // The faction daemon saving for this sleeve (sleeveSavings): every other
    // spender is holding back for it, so buy with the full balance.
    const savingForSleeve = savings?.reason === SLEEVE_SAVINGS_REASON;
    const budget = savingForSleeve ? money : Math.max(0, money - effectiveReserve(0, savings)) * config.investSpendFraction;
    const memory = Array.from({ length: ns.sleeve.getNumSleeves() }, (_, index) => ({
      index,
      memory: ns.sleeve.getSleeve(index).memory,
      upgradeCost: ns.sleeve.getMemoryUpgradeCost(index, 1),
    }));
    const decision = decideSleeveInvestment(node, covenantMember, budget, ns.sleeve.getSleeveCost(), memory);

    if (decision.buySleeve) {
      // Needs only BN10, Covenant membership and cash; a refusal's message
      // says which (logged once per change).
      const result = ns.sleeve.purchaseSleeve();
      if (result.success) {
        await log.info(`[Sleeve] Bought a new sleeve from ${COVENANT} (now ${ns.sleeve.getNumSleeves()}).`);
        lastSleeveMessage = undefined;
        continue;
      }
      if (result.message !== lastSleeveMessage) {
        lastSleeveMessage = result.message;
        await log.info(`[Sleeve] Couldn't buy a sleeve yet: ${result.message}`);
      }
    }
    if (decision.memoryFor === undefined) break;
    const upgrade = ns.sleeve.upgradeMemory(decision.memoryFor, 1);
    if (!upgrade.success) {
      await log.warn(`[Sleeve] Memory upgrade for sleeve ${decision.memoryFor} failed: ${upgrade.message}`);
      break;
    }
    await log.info(`[Sleeve] Upgraded sleeve ${decision.memoryFor}'s memory to ${ns.sleeve.getSleeve(decision.memoryFor).memory}.`);
  }
  return { nextSleeveCost: ns.sleeve.getSleeveCost(), lastMessage: lastSleeveMessage };
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "SleeveShop", LOG_LEVEL.INFO);
  const config = loadJsonConfig<SleeveConfig>(ns, CONFIG_PATH, DEFAULT_CONFIG);
  try {
    lastSleeveMessage = (JSON.parse(ns.read(SLEEVE_SHOP_PATH) || "{}") as Partial<SleeveShopFile>).lastMessage;
  } catch {
    lastSleeveMessage = undefined;
  }
  const shop = await investInSleeves(ns, log, config, readBitNodeInfo(ns)?.node, ns.getPlayer().factions as string[]);
  await buySleeveAugs(ns, log, config);
  const file: SleeveShopFile = {
    nextSleeveCost: shop?.nextSleeveCost,
    lastMessage: shop?.lastMessage,
    augs: Array.from({ length: ns.sleeve.getNumSleeves() }, (_, i) => ns.sleeve.getSleeveAugmentations(i).length),
    writtenAt: Date.now(),
  };
  ns.write(SLEEVE_SHOP_PATH, JSON.stringify(file), "w");
}
