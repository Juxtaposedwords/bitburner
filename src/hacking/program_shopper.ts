import { NS } from "@ns";
import { createLogger, Logger, LOG_LEVEL } from "system/logs";
import { effectiveReserve, readSavings } from "system/savings";

/**
 * Buys the infrastructure everything else runs on, in order: TOR, the port
 * openers (more servers to root), home RAM, and Formulas.exe.
 *
 * Home RAM used to be bought by nothing at all. In a fresh BitNode home is
 * small, and boot.js simply can't fit the later daemons ("insufficient
 * RAM?") - the first BN10 boot started without its scheduler. Upgrades
 * survive installs (only a new BitNode resets them), so they keep paying for
 * the rest of the node. After each upgrade this re-runs boot.js, which
 * launches whatever didn't fit before (it's idempotent - see boot.ts).
 * Formulas.exe matters because a new BitNode takes it away and much of the
 * code falls back to cruder logic without it (training costs, exact rates).
 *
 * Also system/bootstrap/bootstrap.ts's buyer: it runs this with `--once` when cash covers a
 * purchase, so bootstrap itself needn't carry these calls' 7 GB (see main).
 *
 * One of a small set of files allowed to reference ns.singularity.* - each
 * kept isolated so its RAM cost (2-32 GB per function depending on
 * Source-File 4's level, see server_metadata.md) never leaks into another
 * script's footprint. Only launched by boot.ts when
 * PlayerMetadata.singularityAvailable is true.
 */
const PORT_OPENER_PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"] as const;
const FORMULAS = "Formulas.exe";
const BOOT_SCRIPT = "boot.js";
// --once: how long to keep trying to start boot.js (see main()).
const BOOT_RETRIES = 120;
const BOOT_RETRY_MS = 500;

// A home RAM upgrade may use this share of cash above the reserve - it's the
// best-value purchase early on, but shouldn't drain everything in one go.
export const HOME_RAM_SPEND_FRACTION = 0.5;

const POLL_INTERVAL_MS = 30_000;

/**
 * Whether to buy the next home RAM upgrade: it costs at most
 * `spendFraction` of cash, and doesn't dip into `reserve` (the larger of a
 * configured reserve and the shared savings target, see savings.ts). Not
 * finite once home is at the game's maximum.
 */
export function shouldUpgradeHomeRam(cost: number, money: number, reserve: number, spendFraction: number): boolean {
  if (!Number.isFinite(cost) || cost <= 0) return false;
  return cost <= Math.min(money - reserve, money * spendFraction);
}

/**
 * One pass over everything worth buying; true if home RAM was upgraded.
 * `spendFraction` caps each home RAM upgrade's share of cash; with
 * `repeatRam`, keeps upgrading while affordable instead of once per pass.
 */
async function purchasePass(ns: NS, log: Logger, spendFraction: number, repeatRam: boolean): Promise<boolean> {
  // Idempotent - returns true if already owned, so this is safe to call every pass.
  ns.singularity.purchaseTor();

  const reserve = effectiveReserve(0, readSavings(ns));
  const spendable = (): number => ns.getServerMoneyAvailable("home") - reserve;

  for (const program of PORT_OPENER_PROGRAMS) {
    // 0 = already owned, -1 = no TOR yet. Either way, nothing to buy.
    // Port openers ignore the savings target: they cost at most $250M and
    // gate rooting everything - a $126T QLink save once blocked HTTPWorm
    // and SQLInject for a whole run, leaving megacorp/ecorp/blade unrooted.
    const cost = ns.singularity.getDarkwebProgramCost(program);
    if (cost > 0 && cost <= ns.getServerMoneyAvailable("home")) {
      if (ns.singularity.purchaseProgram(program)) {
        await log.info(`[ProgramShopper] Purchased ${program} for $${cost.toLocaleString()}.`);
      }
    }
  }

  let upgraded = false;
  do {
    const ramCost = ns.singularity.getUpgradeHomeRamCost();
    if (!shouldUpgradeHomeRam(ramCost, ns.getServerMoneyAvailable("home"), reserve, spendFraction) || !ns.singularity.upgradeHomeRam()) break;
    upgraded = true;
    await log.info(`[ProgramShopper] Upgraded home RAM to ${ns.getServerMaxRam("home")} GB for $${ramCost.toLocaleString()}.`);
  } while (repeatRam);

  const formulasCost = ns.singularity.getDarkwebProgramCost(FORMULAS);
  // Like the port openers, not held back by savings: every planning formula needs it.
  if (formulasCost > 0 && formulasCost <= ns.getServerMoneyAvailable("home")) {
    if (ns.singularity.purchaseProgram(FORMULAS)) {
      await log.info(`[ProgramShopper] Purchased ${FORMULAS} for $${formulasCost.toLocaleString()}.`);
    }
  }
  return upgraded;
}

/**
 * Normally a daemon: a purchase pass every POLL_INTERVAL_MS, re-running
 * boot.js after each home RAM upgrade. With `--once` (system/bootstrap/bootstrap.ts's hand
 * off): a single pass spending all cash - home RAM as far as it goes, since
 * that's the way out of bootstrap - then boot.js, then exit.
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "ProgramShopper", LOG_LEVEL.INFO);

  if (ns.args.includes("--once")) {
    await purchasePass(ns, log, 1, true);
    // The bootstrap that ran this exits right after, but its RAM can still
    // be held on the first try - one attempt then left nothing running at
    // all (BN12 runs 2 and 3, BN9's start). Retry until it's freed.
    for (let tries = 0; tries < BOOT_RETRIES; tries++) {
      if (ns.run(BOOT_SCRIPT) !== 0) return;
      await ns.asleep(BOOT_RETRY_MS);
    }
    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    const running = ns.ps("home").map((p) => p.filename).join(", ");
    ns.write(
      "/var/claude_out/boot.txt",
      `[${new Date().toISOString()}] program_shopper --once couldn't start ${BOOT_SCRIPT} in ${(BOOT_RETRIES * BOOT_RETRY_MS) / 1000}s: ` +
        `${free.toFixed(1)} GB free, it needs ${ns.getScriptRam(BOOT_SCRIPT, "home")}; running: ${running}\n`,
      "a"
    );
    return;
  }

  while (true) {
    // Launch whatever boot couldn't fit before; boot skips anything running.
    // No scriptRunning check first (1 GB): ns.run already refuses a second
    // copy of a running script with the same args.
    if (await purchasePass(ns, log, HOME_RAM_SPEND_FRACTION, false)) ns.run(BOOT_SCRIPT);
    await ns.asleep(POLL_INTERVAL_MS);
  }
}
