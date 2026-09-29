import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { isInstallPendingActive, readInstallPending } from "development/libraries/install_handshake";
import { effectiveReserve, readSavings } from "development/libraries/savings";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import {
  decideHashSpend,
  decideNodeInvestment,
  hashCapacityBound,
  MaxPayback,
  NodeUpgradeCosts,
  prioritizeForActivity,
  PurchaseDecision,
} from "development/metadata/hacknet_decisions";
import * as player_metadata_pb from "development/metadata/player_metadata";
import { ACTIVITY_PATH, ActivityFile } from "development/metadata/study_decisions";
import { NewSchedulerServiceClient } from "development/metadata/scheduler";
import { resolveTarget } from "development/metadata/scheduler_daemon";
import * as server_metadata_pb from "development/metadata/server_metadata";

// HacknetServerHashUpgrade isn't exported by name from "@ns" - pull it out
// structurally from the one function signature that needs it instead of
// duplicating the literal union here.
type HashUpgradeName = Parameters<NS["hacknet"]["hashCost"]>[0];

// No proto/RPC for this config - nothing else in the codebase needs to
// query or patch it remotely (see server_metadata.md). loadJsonConfig
// writes these defaults out to /etc/hacknet.txt on first run and re-reads
// it fresh every tick below, so hand-editing the file is all "patching"
// this needs - no restart, no RPC round trip.
type HacknetConfig = {
  enabled: boolean;
  // Absolute cash floor never spent below.
  reserveMoney: number;
  // Relative throttle: never commit more than this fraction of *current*
  // money in one tick, even before the floor above is reached.
  maxSpendFraction: number;
  // With Formulas.exe: skip any purchase that wouldn't pay for itself within
  // this many hours (see decideNodeInvestment's maxPayback). An install
  // wipes the Hacknet, so this is roughly "how long until the next
  // install". 0 = no limit.
  maxPaybackHours: number;
  // Ordered, most-preferred-first. Must exactly match one of Bitburner's
  // hash upgrade names (ns.hacknet.getHashUpgrades()) - an unrecognized
  // or currently-unaffordable entry is skipped, not an error. Each tick
  // buys as many as it can afford, not just one (see decideHashSpend).
  hashSpendPriority: string[];
  // Sold only once hashes pass hashDrainAboveFraction of capacity - hashes
  // past capacity are lost, but draining every tick would stop hashes ever
  // building up for the priority upgrades.
  hashDrainUpgrade: string;
  hashDrainAboveFraction: number;
  // Target for upgrades that need one (see TARGET_SCOPED_UPGRADES). Unset
  // = reuse whatever scheduler_daemon.ts is currently attacking, so hash
  // spending automatically synergizes with the HWGW loop.
  hashSpendTargetOverride?: string;
};

const DEFAULT_CONFIG: HacknetConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  maxPaybackHours: 4,
  // Tuned for BN9, where script hacking gives 5% of normal experience and
  // almost no money: Improve Studying multiplies university class
  // experience (which BN9 doesn't nerf) - the real path to hacking level
  // here. Improve Gym Training does the same for combat stats (criminal
  // factions). The HWGW-target upgrades (Reduce Minimum Security /
  // Increase Maximum Money) only pay off where script hacking does.
  hashSpendPriority: ["Improve Studying", "Improve Gym Training"],
  hashDrainUpgrade: "Sell for Money",
  hashDrainAboveFraction: 0.9,
};

// Safety bound on purchases per tick - a drain at 4 hashes each can take
// many calls; whatever's left gets picked up next tick.
const MAX_HASH_SPENDS_PER_TICK = 500;
// Same idea for node purchases/upgrades.
const MAX_PURCHASES_PER_TICK = 200;
// study_daemon.ts writes every 10s; allow a few missed writes.
const ACTIVITY_MAX_AGE_MS = 60_000;

// "Sell for Money" pays a flat $1M per purchase (Bitburner's HashUpgrades);
// its hash cost is read live.
const SELL_FOR_MONEY = "Sell for Money";
const SELL_FOR_MONEY_PAYOUT = 1e6;

const CONFIG_PATH = "/etc/hacknet.txt";

// Purchases/upgrades are lumpy, infrequent decisions - no need for
// scheduler_daemon.ts's 1000ms batch-check granularity.
const TICK_INTERVAL_MS = 5000;

// The only two hash upgrades ns.hacknet.spendHashes needs a target for.
const TARGET_SCOPED_UPGRADES = new Set(["Reduce Minimum Security", "Increase Maximum Money"]);

/** Live per-node current stats + upgrade costs. cacheCost is only meaningful for Hacknet Servers (see hacknet_decisions.ts). */
function gatherNodes(ns: NS, isServerContext: boolean): NodeUpgradeCosts[] {
  const nodes: NodeUpgradeCosts[] = [];
  for (let index = 0; index < ns.hacknet.numNodes(); index++) {
    const stats = ns.hacknet.getNodeStats(index);
    nodes.push({
      index,
      level: stats.level,
      ram: stats.ram,
      cores: stats.cores,
      levelCost: ns.hacknet.getLevelUpgradeCost(index),
      ramCost: ns.hacknet.getRamUpgradeCost(index),
      coreCost: ns.hacknet.getCoreUpgradeCost(index),
      cacheCost: isServerContext ? ns.hacknet.getCacheUpgradeCost(index) : undefined,
    });
  }
  return nodes;
}

/**
 * ns.formulas.hacknetServers.hashGainRate/ns.formulas.hacknetNodes.
 * moneyGainRate - the real production formula, gated behind owning
 * Formulas.exe (checked fresh every tick, no restart needed once bought).
 * Unlike every other capability-gated API touched this session, every
 * ns.formulas.* function has 0 GB RAM cost - the gate is file ownership,
 * not something worth isolating into a separate script the way SF4/
 * Singularity was. ramUsed is always passed as 0 - see hacknet_decisions.ts's
 * module doc for why that's an acceptable simplification here.
 */
function buildGainRate(ns: NS, isServerContext: boolean): ((level: number, ram: number, cores: number) => number) | undefined {
  if (!ns.fileExists("Formulas.exe", "home")) return undefined;

  return isServerContext
    ? (level, ram, cores) => ns.formulas.hacknetServers.hashGainRate(level, 0, ram, cores)
    : (level, ram, cores) => ns.formulas.hacknetNodes.moneyGainRate(level, ram, cores);
}

/** Carries out a PurchaseDecision against the live game; returns a short label for the tick summary ("new node", "level", ...), or undefined if there was nothing to do or it failed. */
function executeInvestment(ns: NS, decision: PurchaseDecision): string | undefined {
  if (decision.kind === "none") return undefined;

  if (decision.kind === "buyNode") {
    const index = ns.hacknet.purchaseNode();
    return index === -1 ? undefined : "new node";
  }

  const { index, upgrade } = decision;
  const ok =
    upgrade === "level"
      ? ns.hacknet.upgradeLevel(index)
      : upgrade === "ram"
        ? ns.hacknet.upgradeRam(index)
        : upgrade === "core"
          ? ns.hacknet.upgradeCore(index)
          : ns.hacknet.upgradeCache(index);
  return ok ? upgrade : undefined;
}

/** config.hashSpendTargetOverride wins when set; otherwise reuses scheduler_daemon.ts's current target rather than re-deriving it. */
async function resolveHashTarget(ns: NS, config: HacknetConfig): Promise<string | undefined> {
  if (config.hashSpendTargetOverride) return config.hashSpendTargetOverride;

  const res = await NewSchedulerServiceClient(ns).GetSchedulerConfig({});
  if (res.status !== Codes.OK) return undefined;

  return resolveTarget(ns, res.data?.config ?? {});
}

/**
 * decideNodeInvestment's payback limit. A hash is valued at what "Sell for
 * Money" pays for it - a floor, since the priority upgrades are bought
 * because they're worth more than that. Plain Hacknet Nodes produce money
 * directly. undefined (no limit) when maxPaybackHours is 0.
 */
function paybackLimit(ns: NS, config: HacknetConfig, isServerContext: boolean, validNames: Set<string>): MaxPayback | undefined {
  if (!(config.maxPaybackHours > 0)) return undefined;
  const seconds = config.maxPaybackHours * 3600;
  if (!isServerContext) return { seconds, valuePerUnit: 1 };
  if (!validNames.has(SELL_FOR_MONEY)) return undefined;
  return { seconds, valuePerUnit: SELL_FOR_MONEY_PAYOUT / ns.hacknet.hashCost(SELL_FOR_MONEY as HashUpgradeName) };
}

/** Whether the priority hash upgrades have outgrown hash capacity, so cache upgrades should come first (see hashCapacityBound). */
function priorityCapacityBound(ns: NS, config: HacknetConfig, validNames: Set<string>): boolean {
  const costs: Record<string, number> = {};
  for (const name of config.hashSpendPriority) {
    if (validNames.has(name)) costs[name] = ns.hacknet.hashCost(name as HashUpgradeName);
  }
  return hashCapacityBound(config.hashSpendPriority, costs, ns.hacknet.hashCapacity(), config.hashDrainAboveFraction);
}

/**
 * study_daemon.ts's current activity, or undefined when its file is missing,
 * unreadable, or stale (older than ACTIVITY_MAX_AGE_MS - a stopped study
 * daemon shouldn't keep reordering hash spending).
 */
function readActivity(ns: NS): string | undefined {
  const raw = ns.read(ACTIVITY_PATH);
  if (!raw) return undefined;
  try {
    const file = JSON.parse(raw) as ActivityFile;
    return Date.now() - file.writtenAt <= ACTIVITY_MAX_AGE_MS ? file.kind : undefined;
  } catch {
    return undefined;
  }
}

async function tick(ns: NS, log: Logger, configIn: HacknetConfig): Promise<void> {
  // Whatever the player is training right now gets its hash upgrade first
  // (prioritizeForActivity); the configured order applies otherwise.
  const activity = readActivity(ns);
  const config: HacknetConfig = { ...configIn, hashSpendPriority: prioritizeForActivity(configIn.hashSpendPriority, activity) };

  const playerRes = await player_metadata_pb
    .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
    .GetPlayerMetadata({});
  const money = playerRes.data?.player?.money ?? 0;

  const isServerContext = ns.hacknet.hashCapacity() > 0;
  const gainRate = buildGainRate(ns, isServerContext);
  const validNames = new Set<string>(ns.hacknet.getHashUpgrades());
  const maxPayback = paybackLimit(ns, config, isServerContext, validNames);

  // Keep buying until the tick's budget or the payback limit runs out,
  // re-reading nodes and costs after every purchase. One purchase per 5s
  // tick capped a full build-out (~9,000 purchases) at about 12 hours,
  // however much cash there was.
  // The shared savings target (savings.ts) counts as a reserve too. During
  // a pending install nothing is bought: an install resets the Hacknet.
  const installPending = isInstallPendingActive(readInstallPending(ns), Math.floor(Date.now() / 1000));
  const reserve = installPending ? Infinity : effectiveReserve(config.reserveMoney, readSavings(ns));
  let remaining = Math.max(0, Math.min(money - reserve, money * config.maxSpendFraction));
  const purchased: Record<string, number> = {};
  let spent = 0;
  for (let i = 0; i < MAX_PURCHASES_PER_TICK; i++) {
    const capacityBound = isServerContext && priorityCapacityBound(ns, config, validNames);
    const { decision, budget, bestCandidate, candidateCount } = decideNodeInvestment(
      remaining,
      0,
      1,
      ns.hacknet.getPurchaseNodeCost(),
      ns.hacknet.numNodes() >= ns.hacknet.maxNumNodes(),
      gatherNodes(ns, isServerContext),
      gainRate,
      capacityBound,
      maxPayback
    );
    if (i === 0) {
      await log.debug(
        `[Hacknet] node tick: money=$${money.toFixed(0)} budget=$${budget.toFixed(0)} candidates=${candidateCount} mode=${gainRate ? "ROI" : "cheapest-first"} ` +
          `capacityBound=${capacityBound} maxPaybackHours=${config.maxPaybackHours} ` +
          `best=${bestCandidate ? `$${bestCandidate.cost.toFixed(0)} (${JSON.stringify(bestCandidate.decision)})` : "n/a"} -> ${decision.kind}`
      );
    }

    const before = ns.getServerMoneyAvailable("home");
    const done = executeInvestment(ns, decision);
    if (!done) break;
    const cost = before - ns.getServerMoneyAvailable("home");
    remaining -= cost;
    spent += cost;
    purchased[done] = (purchased[done] ?? 0) + 1;
  }
  const purchaseSummary = Object.entries(purchased).map(([what, n]) => `${what} x${n}`).join(", ");
  if (purchaseSummary) await log.info(`[Hacknet] Spent $${spent.toExponential(2)}: ${purchaseSummary}.`);

  if (!isServerContext) return;

  const capacity = ns.hacknet.hashCapacity();
  const names = [...config.hashSpendPriority, config.hashDrainUpgrade].filter((name) => validNames.has(name));
  const startHashes = ns.hacknet.numHashes();
  const bought: Record<string, number> = {};
  let target: string | undefined;

  // Loop, re-querying costs after every purchase (they rise per level), until
  // nothing on the list is affordable. The old one-purchase-per-tick version
  // let production outrun spending, and hashes past capacity are lost.
  for (let i = 0; i < MAX_HASH_SPENDS_PER_TICK; i++) {
    const numHashes = ns.hacknet.numHashes();
    const costs: Record<string, number> = {};
    for (const name of names) costs[name] = ns.hacknet.hashCost(name as HashUpgradeName);
    const spend = decideHashSpend(config.hashSpendPriority, numHashes, capacity, costs, config.hashDrainUpgrade, config.hashDrainAboveFraction);
    if (!spend) break;

    if (TARGET_SCOPED_UPGRADES.has(spend.upgrade) && !target) {
      target = await resolveHashTarget(ns, config);
      if (!target) {
        await log.warn(`[Hacknet] "${spend.upgrade}" needs a target but none is resolvable yet; stopping hash spending this tick.`);
        break;
      }
    }
    if (!ns.hacknet.spendHashes(spend.upgrade as HashUpgradeName, TARGET_SCOPED_UPGRADES.has(spend.upgrade) ? target : undefined)) break;
    bought[spend.upgrade] = (bought[spend.upgrade] ?? 0) + 1;
  }

  const summary = Object.entries(bought).map(([name, n]) => `${name} x${n}`).join(", ");
  if (summary) await log.info(`[Hacknet] Spent hashes: ${summary}${target ? ` (target: ${target})` : ""}.`);
  await log.debug(
    `[Hacknet] hash tick: hashes ${startHashes.toFixed(0)} -> ${ns.hacknet.numHashes().toFixed(0)} of ${capacity.toFixed(0)} capacity, ` +
      `bought: ${summary || "nothing affordable"} activity=${activity ?? "unknown"} priority=${JSON.stringify(config.hashSpendPriority)}`
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so every tick's evaluation is visible, not just successful
  // purchases/upgrades/hash-spends - a "did nothing" tick otherwise looks
  // identical to a hung process from the logs alone (see server_metadata.md).
  const log = createLogger(ns, "Hacknet", LOG_LEVEL.DEBUG);

  await log.info("=== Hacknet manager online ===");

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      await tick(ns, log, config);
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
