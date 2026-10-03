import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { isInstallPendingActive, readInstallPending } from "development/libraries/install_handshake";
import { effectiveReserve, readSavings } from "development/libraries/savings";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import {
  chooseHashUpgrade,
  COMPANY_FAVOR,
  decideNodeInvestment,
  HACKNET_STATUS_PATH,
  HacknetStatusFile,
  HashChoice,
  HashChoiceInputs,
  INCREASE_MAX_MONEY,
  MaxPayback,
  NodeUpgradeCosts,
  nodePolicy,
  PurchaseDecision,
  IMPROVE_GYM as IMPROVE_GYM_NAME,
  IMPROVE_STUDYING as IMPROVE_STUDYING_NAME,
  REDUCE_MIN_SECURITY,
  SELL_FOR_MONEY,
} from "development/metadata/hacknet_decisions";
import { FACTION_REPS_PATH, FactionRepsFile, INSTALL_LOOP_PATH, InstallLoopFile } from "development/metadata/faction_decisions";
import { incomePerMin } from "development/libraries/timeseries";
import { readFreshJson } from "development/libraries/fresh_file";
import { SLEEVES_PATH, SleevesFile } from "development/metadata/sleeve_decisions";
import * as player_metadata_pb from "development/metadata/player_metadata";
import { ACTIVITY_PATH, ActivityFile } from "development/metadata/study_decisions";
import { Approach } from "development/metadata/scheduler";
import { readApproach } from "development/libraries/approach";
import { SCHEDULER_TARGETS_PATH, SchedulerTargetsFile, topEarner } from "development/metadata/hwgw";
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
  // Sell for Money only past this fraction of hash capacity, while saving
  // for an upgrade that costs more than the hashes on hand.
  hashDrainAboveFraction: number;
  // Server for Reduce Minimum Security / Increase Maximum Money. Unset = the
  // scheduler's top-earning target (SCHEDULER_TARGETS_PATH).
  hashSpendTargetOverride?: string;
  // Outside AUGMENTS' install loop, buy any node, upgrade or cache costing
  // at most this many minutes of income (nodePolicy) in place of the
  // maxPaybackHours test. 0 = always use the payback test.
  incomeBudgetMinutes: number;
  // ...and spend at most this fraction of income on the Hacknet in total.
  incomeShare: number;
};

const DEFAULT_CONFIG: HacknetConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  maxPaybackHours: 4,
  hashDrainAboveFraction: 0.9,
  incomeBudgetMinutes: 10,
  incomeShare: 0.05,
};

// Income measured over this window for incomeBudgetMinutes.
const INCOME_WINDOW_SEC = 10 * 60;
// faction_daemon.ts writes its files every tick; a stopped daemon's stale
// flags shouldn't steer anything.
const FACTION_FILE_MAX_AGE_MS = 60_000;

const readFresh = <T extends { writtenAt: number }>(ns: NS, path: string): T | undefined => readFreshJson<T>(ns, path, FACTION_FILE_MAX_AGE_MS);

// Safety bound on purchases per tick - a drain at 4 hashes each can take
// many calls; whatever's left gets picked up next tick.
const MAX_HASH_SPENDS_PER_TICK = 500;
// Same idea for node purchases/upgrades.
const MAX_PURCHASES_PER_TICK = 200;
// study_daemon.ts writes every 10s; allow a few missed writes.
const ACTIVITY_MAX_AGE_MS = 60_000;

// "Sell for Money" pays a flat $1M per purchase (Bitburner's HashUpgrades);
// its hash cost is read live.
const SELL_FOR_MONEY_PAYOUT = 1e6;

const CONFIG_PATH = "/etc/hacknet.txt";

// Purchases/upgrades are lumpy, infrequent decisions - no need for
// scheduler_daemon.ts's 1000ms batch-check granularity.
const TICK_INTERVAL_MS = 5000;

// The scheduler writes its targets file every 5s.
const SCHEDULER_FILE_MAX_AGE_MS = 60_000;

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
  const choiceInputs = gatherHashInputs(ns, configIn);
  const config = configIn;
  const installLoop = readFresh<InstallLoopFile>(ns, INSTALL_LOOP_PATH)?.active === true;
  const policy = nodePolicy(installLoop, incomePerMin(ns, INCOME_WINDOW_SEC), config.incomeBudgetMinutes, config.incomeShare, TICK_INTERVAL_MS / 60_000);

  const playerRes = await player_metadata_pb
    .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
    .GetPlayerMetadata({});
  const money = playerRes.data?.player?.money ?? 0;

  const isServerContext = ns.hacknet.hashCapacity() > 0;
  const gainRate = buildGainRate(ns, isServerContext);
  const validNames = new Set<string>(ns.hacknet.getHashUpgrades());
  const maxPayback = policy.kind === "payback" ? paybackLimit(ns, config, isServerContext, validNames) : undefined;
  const maxItemCost = policy.kind === "income" ? policy.maxItemCost : Infinity;

  // Keep buying until the tick's budget or the payback limit runs out,
  // re-reading nodes and costs after every purchase. One purchase per 5s
  // tick capped a full build-out (~9,000 purchases) at about 12 hours,
  // however much cash there was.
  // The shared savings target (savings.ts) counts as a reserve too. During
  // a pending install nothing is bought: an install resets the Hacknet.
  const installPending = isInstallPendingActive(readInstallPending(ns), Math.floor(Date.now() / 1000));
  // Under the income policy spending is already capped at incomeShare of
  // income, so the savings target doesn't hold it back (like gang
  // equipment): a long save (9.3h for QLink) would otherwise leave the
  // Hacknet an install wiped at 0 servers throughout.
  const reserve =
    installPending || policy.kind === "none"
      ? Infinity
      : policy.kind === "income"
        ? config.reserveMoney
        : effectiveReserve(config.reserveMoney, readSavings(ns));
  let remaining = Math.max(0, Math.min(money - reserve, money * config.maxSpendFraction, policy.kind === "income" ? policy.tickBudget : Infinity));
  const purchased: Record<string, number> = {};
  let spent = 0;
  for (let i = 0; i < MAX_PURCHASES_PER_TICK; i++) {
    // Cache first when the upgrade being saved for can't fit under the sell line.
    const wantedCost = isServerContext ? hashCostOf(ns, chooseHashUpgrade(choiceInputs(ns.hacknet.numHashes())).wanted) : undefined;
    const capacityBound = wantedCost !== undefined && wantedCost > config.hashDrainAboveFraction * ns.hacknet.hashCapacity();
    const { decision, budget, bestCandidate, candidateCount } = decideNodeInvestment(
      remaining,
      0,
      1,
      ns.hacknet.getPurchaseNodeCost(),
      ns.hacknet.numNodes() >= ns.hacknet.maxNumNodes(),
      gatherNodes(ns, isServerContext),
      gainRate,
      capacityBound,
      maxPayback,
      maxItemCost
    );
    if (i === 0) {
      await log.debug(
        `[Hacknet] node tick: money=$${money.toFixed(0)} budget=$${budget.toFixed(0)} candidates=${candidateCount} mode=${gainRate ? "ROI" : "cheapest-first"} ` +
          `capacityBound=${capacityBound} policy=${policy.kind === "income" ? `income (max $${policy.maxItemCost.toExponential(2)} each)` : policy.kind === "none" ? "none (install loop)" : `payback ${config.maxPaybackHours}h`} ` +
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

  const production = Array.from({ length: ns.hacknet.numNodes() }, (_, i) => ns.hacknet.getNodeStats(i).production);
  const writeStatus = (hashSpending: string): void => {
    const status: HacknetStatusFile = {
      nodes: ns.hacknet.numNodes(),
      maxNodes: ns.hacknet.maxNumNodes(),
      servers: isServerContext,
      productionPerSec: production.reduce((a, b) => a + b, 0),
      hashes: isServerContext ? ns.hacknet.numHashes() : 0,
      hashCapacity: isServerContext ? ns.hacknet.hashCapacity() : 0,
      policy: policy.kind,
      hashSpending,
      writtenAt: Date.now(),
    };
    ns.write(HACKNET_STATUS_PATH, JSON.stringify(status), "w");
  };

  if (!isServerContext) {
    writeStatus("");
    return;
  }

  const capacity = ns.hacknet.hashCapacity();
  const startHashes = ns.hacknet.numHashes();
  const bought: Record<string, number> = {};
  let last: { buy?: HashChoice; wanted?: HashChoice } = {};

  // Loop, re-querying costs after every purchase (they rise per level),
  // until nothing applicable is affordable (chooseHashUpgrade).
  for (let i = 0; i < MAX_HASH_SPENDS_PER_TICK; i++) {
    last = chooseHashUpgrade(choiceInputs(ns.hacknet.numHashes()));
    const buy = last.buy;
    if (!buy) break;
    if (!ns.hacknet.spendHashes(buy.upgrade as HashUpgradeName, buy.target)) break;
    const key = buy.target ? `${buy.upgrade}@${buy.target}` : buy.upgrade;
    bought[key] = (bought[key] ?? 0) + 1;
  }

  const summary = Object.entries(bought).map(([name, n]) => `${name} x${n}`).join(", ");
  const describe = (c?: HashChoice): string => (c ? `${c.upgrade}${c.target ? `@${c.target}` : ""} (${c.reason})` : "nothing applies");
  writeStatus(`next ${describe(last.wanted)}${summary ? `; last tick bought ${summary}` : ""}`);
  if (summary) await log.info(`[Hacknet] Spent hashes: ${summary}.`);
  await log.debug(
    `[Hacknet] hash tick: hashes ${startHashes.toFixed(0)} -> ${ns.hacknet.numHashes().toFixed(0)} of ${capacity.toFixed(0)} capacity, ` +
      `bought: ${summary || "nothing"}; next ${describe(last.wanted)}`
  );
}

/** Live hash cost of a choice, undefined for none. */
function hashCostOf(ns: NS, choice: HashChoice | undefined): number | undefined {
  return choice ? ns.hacknet.hashCost(choice.upgrade as HashUpgradeName) : undefined;
}

/**
 * chooseHashUpgrade's inputs, from what the other daemons publish: invite
 * blockers and gym sessions (faction daemon), sleeve goals, the study
 * activity, company targets, and the scheduler's per-target income.
 * Returns a builder taking the current hash count.
 */
function gatherHashInputs(ns: NS, config: HacknetConfig): (numHashes: number) => HashChoiceInputs {
  const faction = readFresh<FactionRepsFile>(ns, FACTION_REPS_PATH);
  const sleeveGoals = (readFresh<SleevesFile>(ns, SLEEVES_PATH)?.sleeves ?? []).map((s) => s.goal);
  const study = readActivity(ns);
  const blockers = Object.values(faction?.inviteBlockers ?? {}).flat().join("; ");
  const combatBlocked = /\b(strength|defense|dexterity|agility) \d+ \(have/.test(blockers);
  const hackingBlocked = /\bhacking \d+ \(have/.test(blockers);
  // Gym sessions the faction daemon or a sleeve runs are always for a goal
  // (an invite's combat stats, or the gang's karma crime).
  const gymForGoal = faction?.gymTraining === true || sleeveGoals.some((g) => g.startsWith("gym")) || (study === "gym" && combatBlocked);
  const studying = study === "class" || sleeveGoals.some((g) => g.startsWith("study"));
  const classForGoal = studying && (readApproach(ns) === Approach.GROW_STATS || hackingBlocked);

  const targets = readFreshJson<SchedulerTargetsFile>(ns, SCHEDULER_TARGETS_PATH, SCHEDULER_FILE_MAX_AGE_MS)?.targets ?? [];
  const earner = config.hashSpendTargetOverride
    ? { host: config.hashSpendTargetOverride, chance: ns.hackAnalyzeChance(config.hashSpendTargetOverride) }
    : topEarner(targets);

  const valid = new Set<string>(ns.hacknet.getHashUpgrades());
  const names = [IMPROVE_GYM_NAME, IMPROVE_STUDYING_NAME, COMPANY_FAVOR, REDUCE_MIN_SECURITY, INCREASE_MAX_MONEY, SELL_FOR_MONEY].filter((n) => valid.has(n));
  return (numHashes) => ({
    numHashes,
    capacity: ns.hacknet.hashCapacity(),
    costs: Object.fromEntries(names.map((n) => [n, ns.hacknet.hashCost(n as HashUpgradeName)])),
    gymForGoal,
    classForGoal,
    companyTarget: faction?.companyTargets?.[0]?.company,
    topEarner: earner ? { host: earner.host, chance: earner.chance } : undefined,
    sellAboveFraction: config.hashDrainAboveFraction,
  });
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
