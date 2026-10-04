import { NS } from "@ns";

/**
 * One savings target every spender respects, instead of editing each
 * daemon's reserveMoney by hand (BN9's $100B Daedalus wait took five config
 * edits in and five out).
 *
 * faction_daemon.ts is the only writer: while it's saving for a priority
 * augmentation (see faction_decisions.ts's priorityFocus) it writes the
 * augmentation's price plus any donation still needed, refreshed every tick,
 * and clears it otherwise. Hacknet, gang, stock and purchased-server daemons
 * read it and spend only above max(their own reserveMoney, amount). The stock
 * daemon also sells everything once cash plus stock value covers the amount,
 * since only cash can buy the augmentation.
 *
 * A stale file (writer died) stops counting, so a crash can't freeze every
 * spender forever.
 */
export const SAVINGS_PATH = "/var/savings.txt";
export const SAVINGS_MAX_AGE_MS = 60_000;

export type Savings = { amount: number; reason: string; writtenAt: number };

/** The target if the file's contents are fresh, else undefined. */
export function parseSavings(raw: string, now: number, maxAgeMs = SAVINGS_MAX_AGE_MS): Savings | undefined {
  if (!raw) return undefined;
  try {
    const savings = JSON.parse(raw) as Savings;
    if (typeof savings.amount !== "number" || typeof savings.writtenAt !== "number") return undefined;
    return now - savings.writtenAt <= maxAgeMs && savings.amount > 0 ? savings : undefined;
  } catch {
    return undefined;
  }
}

export function readSavings(ns: NS): Savings | undefined {
  return parseSavings(ns.read(SAVINGS_PATH), Date.now());
}

/** Writes the target, or removes it for an amount of 0. */
export function writeSavings(ns: NS, amount: number, reason: string): void {
  if (amount > 0) ns.write(SAVINGS_PATH, JSON.stringify({ amount, reason, writtenAt: Date.now() }), "w");
  else ns.rm(SAVINGS_PATH, "home");
}

/** The reserve a spender should keep: its own, or the savings target if higher. */
export function effectiveReserve(configReserve: number, savings: Savings | undefined): number {
  return Math.max(configReserve, savings?.amount ?? 0);
}

/** Sell stock for the target only when cash alone falls short and cash plus stock covers it. */
export function shouldLiquidateForSavings(savings: Savings | undefined, cash: number, stockValue: number): boolean {
  return savings !== undefined && cash < savings.amount && cash + stockValue >= savings.amount;
}
