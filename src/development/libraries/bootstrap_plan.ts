/**
 * Pure logic for the low-RAM startup (bootstrap.ts), shared with boot.ts's
 * decision to use it - no `ns` calls, so importing it adds no RAM cost.
 *
 * The full system (supervisor RPC, scheduler, faction/gang daemons...) is
 * built for a big home. A fresh BitNode starts small - BN10's first boot
 * couldn't fit the scheduler and program shopper together, the player sat
 * at -$80k and hacking 43, and nothing was earning or buying. bootstrap.ts
 * is the self-contained alternative until home can hold CORE_SCRIPTS.
 */

/**
 * Scripts the full system can't usefully run without, all at once on home:
 * the RPC hub and player snapshot, log rotation, the scheduler (income),
 * the program shopper (RAM and programs), and the faction daemon.
 */
export const CORE_SCRIPTS = [
  "development/metadata/supervisor.js",
  "tools/log_rotator.js",
  "development/metadata/player.js",
  "development/metadata/scheduler_daemon.js",
  "tools/program_shopper.js",
  "development/metadata/faction_daemon.js",
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
export function pickBootstrapTarget(servers: BootstrapServer[], hackingLevel: number): string | undefined {
  const cap = hackingLevel < 10 ? hackingLevel : hackingLevel / 2;
  const candidates = servers.filter((s) => s.hasRoot && s.maxMoney > 0 && s.requiredHackingLevel <= cap);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, s) => (s.maxMoney > best.maxMoney ? s : best)).host;
}

// TOR's price: the game has no function to query it before it's bought
// (getDarkwebProgramCost returns -1 without TOR), so it's the one constant.
export const TOR_COST = 200_000;

/**
 * Whether bootstrap.ts should stop and hand the cash to a one-shot shopper
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
