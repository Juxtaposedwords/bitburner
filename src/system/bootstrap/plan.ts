/**
 * Pure logic for the low-RAM startup (system/bootstrap/bootstrap.ts), shared with boot.ts's
 * decision to use it - no `ns` calls, so importing it adds no RAM cost.
 *
 * The full system (supervisor RPC, scheduler, faction/gang daemons...) is
 * built for a big home. A fresh BitNode starts small - BN10's first boot
 * couldn't fit the scheduler and program shopper together, the player sat
 * at -$80k and hacking 43, and nothing was earning or buying. system/bootstrap/bootstrap.ts
 * is the self-contained alternative until home can hold CORE_SCRIPTS.
 */

/**
 * Scripts the full system can't usefully run without, all at once on home:
 * the RPC hub and player snapshot, log rotation, the network daemon, the
 * scheduler (income) and the program shopper (RAM and programs) - ~40 GB.
 * Not the faction daemon (~100 GB): with it the hand-over waited for ~157
 * GB, ~1.5 hours into BN12's second run, while the scheduler (the better
 * earner) sat unused. Nothing is lost meanwhile - the bootstrap's karma
 * crime keeps repeating on its own - and boot starts the faction daemon as
 * soon as it fits (the program shopper re-runs boot after every home RAM
 * upgrade).
 */
export const CORE_SCRIPTS = [
  "system/supervisor.js",
  "system/log_rotator.js",
  "system/player.js",
  "hacking/network_daemon.js",
  "hacking/scheduler_daemon.js",
  "hacking/program_shopper.js",
];

// Room beyond CORE_SCRIPTS for the one-shots boot runs, the next daemons in
// its order, and some home HWGW workers.
export const CORE_RAM_MARGIN_GB = 16;

/**
 * Home RAM the full system needs: every core script's RAM plus the margin.
 * `scriptRams` is ns.getScriptRam per script; a missing script (0) makes
 * the total unknowable, so it returns Infinity (stay in bootstrap).
 */
export function requiredHomeRam(scriptRams: number[], marginGb = CORE_RAM_MARGIN_GB): number {
  if (scriptRams.some((ram) => !(ram > 0))) return Infinity;
  return scriptRams.reduce((sum, ram) => sum + ram, 0) + marginGb;
}

export type BootstrapServer = { host: string; maxMoney: number; requiredHackingLevel: number; hasRoot: boolean };

/**
 * The early-game target: the rooted server with the most money that needs
 * at most half the player's hacking level (the classic early rule - fast,
 * reliable hacks), or at most the full level while hacking is under 10.
 */
export function pickBootstrapTarget(servers: BootstrapServer[], hackingLevel: number, current?: string): string | undefined {
  const cap = hackingLevel < 10 ? hackingLevel : hackingLevel / 2;
  const candidates = servers.filter((s) => s.hasRoot && s.maxMoney > 0 && s.requiredHackingLevel <= cap);
  if (candidates.length === 0) return undefined;
  const best = candidates.reduce((top, s) => (s.maxMoney > top.maxMoney ? s : top));
  // A switch restarts every worker, and the new target is weakened and
  // grown before it's hacked at all: only for one worth at least
  // SWITCH_FACTOR times as much. BN9's start, with hacking rising fast
  // from study, switched every few levels and earned nothing for minutes.
  const kept = candidates.find((s) => s.host === current);
  return kept && best.maxMoney < kept.maxMoney * SWITCH_FACTOR ? kept.host : best.host;
}

// How much richer a target must be to switch to it (pickBootstrapTarget).
export const SWITCH_FACTOR = 2;

// TOR's price: the game has no function to query it before it's bought
// (getDarkwebProgramCost returns -1 without TOR), so it's the one constant.
export const TOR_COST = 200_000;

/**
 * Whether system/bootstrap/bootstrap.ts should stop and hand the cash to a one-shot shopper
 * pass: it can afford something that matters - TOR (if not owned), an
 * unowned port opener (`programCosts`: getDarkwebProgramCost, > 0 = not
 * owned), or the next home RAM upgrade. Keeping the purchase calls out of
 * bootstrap saves 7 GB of its RAM for workers.
 */
export function shouldHandOffToShopper(cash: number, hasTor: boolean, programCosts: number[], nextRamCost: number): boolean {
  if (!hasTor && cash >= TOR_COST) return true;
  if (programCosts.some((cost) => cost > 0 && cost <= cash)) return true;
  return Number.isFinite(nextRamCost) && nextRamCost > 0 && nextRamCost <= cash;
}

/** Whole worker threads that fit in `freeRam` (0 when none do). */
export function workerThreads(freeRam: number, workerRam: number): number {
  return workerRam > 0 ? Math.max(0, Math.floor(freeRam / workerRam)) : 0;
}

export type HacknetOption = { kind: "server" | "level" | "ram" | "core"; index: number; cost: number };

/**
 * BitNode 9's bootstrap income: hacknet servers, whose hashes sell for cash
 * (scripts' hacking pays ~1/1000th there: ServerMaxMoney 0.01 x
 * ScriptHackMoney 0.1). The cheapest improvement - a new server, or a
 * level, RAM or core upgrade on one - if it costs at most `spendFraction`
 * of cash, so the rest still builds toward TOR, programs and home RAM
 * (shouldHandOffToShopper). Cheap upgrades first compound fastest early.
 */
export function pickHacknetPurchase(options: HacknetOption[], cash: number, spendFraction: number): HacknetOption | undefined {
  const affordable = options.filter((o) => Number.isFinite(o.cost) && o.cost > 0 && o.cost <= cash * spendFraction);
  return affordable.length === 0 ? undefined : affordable.reduce((a, b) => (b.cost < a.cost ? b : a));
}

// Share of cash one hacknet purchase may use (pickHacknetPurchase).
export const HACKNET_SPEND_FRACTION = 0.5;

/**
 * The faction daemon and its services (docs/faction_split.md): with the core
 * on home they need either home's room too, or hacked servers of 32 GB or
 * more to run on (system/remote_place.ts). Without either, the full system
 * can't plan or act - BN9 after an install sat in it for hours with a 128 GB
 * home, nothing rooted beyond 16 GB servers, and the faction stack held.
 */
export const FACTION_STACK = [
  "factions/services/faction_info_service.js",
  "factions/services/faction_work_service.js",
  "factions/services/crime_service.js",
  "factions/services/augment_purchase_service.js",
  "factions/faction_daemon.js",
];
// Hacked servers this big take one faction service each.
export const SERVICE_HOST_MIN_RAM = 32;

/**
 * Whether the full system can run: home holds the core (coreRequired), plus
 * the faction stack unless there are enough rooted hacked servers for its
 * services (one each; the faction daemon itself goes on home).
 */
export function fullSystemFits(homeRam: number, coreRequired: number, stackRams: number[], roomyHackedServers: number): boolean {
  if (homeRam < coreRequired) return false;
  const services = stackRams.slice(0, -1);
  const planner = stackRams[stackRams.length - 1] ?? 0;
  if (roomyHackedServers >= services.length) return homeRam >= coreRequired + planner;
  return homeRam >= coreRequired + stackRams.reduce((a, b) => a + b, 0);
}

/**
 * Cash per second from selling hashes: `hashesPerSec` at Sell for Money's
 * payout ($1M per `sellCost` hashes).
 */
export function hashIncomePerSec(hashesPerSec: number, sellCost: number): number {
  return sellCost > 0 ? (hashesPerSec * 1e6) / sellCost : 0;
}

// Below this hash income the player commits a crime for money instead of
// studying (BitNode 9's bootstrap): about what Mug pays at modest stats.
// One level-1 server makes ~0.001 hashes/s ($250/s) - BN9's restart sat on
// one for minutes, studying, with cash flat at $38,626.
export const SEED_INCOME_PER_SEC = 1000;

export type PlayerActivity = "crime" | "study" | "leave";

/**
 * What the bootstrap has the player do: a crime for money while the hacknet
 * is the income (BitNode 9) and earns less than the crime would
 * (SEED_INCOME_PER_SEC); otherwise the free course. Work someone started by
 * hand is left alone - only idle time or the bootstrap's own crime changes.
 */
export function playerActivity(hacknetIncome: boolean, hashIncome: number, currentWork: string | undefined): PlayerActivity {
  if (hacknetIncome && hashIncome < SEED_INCOME_PER_SEC) return currentWork === "CRIME" ? "leave" : "crime";
  return !currentWork || currentWork === "CRIME" ? "study" : "leave";
}
