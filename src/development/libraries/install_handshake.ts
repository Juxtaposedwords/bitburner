import { NS } from "@ns";

/**
 * Pre-install wind-down between faction_daemon.ts and stock_daemon.ts.
 *
 * Installing augmentations deletes every stock position with no refund
 * (initStockMarket() replaces every Stock object, and shares live on those
 * objects) and resets cash to $1,000 - confirmed in Bitburner's
 * StockMarket.ts and PlayerObjectGeneralMethods.ts. TIX API/4S access
 * survives; only a new BitNode clears it. So stock must become cash, and
 * that cash must become augmentations, before an install.
 *
 * faction_daemon.ts owns the file: it writes it when an install is ready
 * but stock is still held, refreshes `heartbeat` every tick while winding
 * down, and deletes it right before installing (or when the wind-down is
 * cancelled). stock_daemon.ts only reads it: while it's active, it sells
 * every position and buys nothing. Only stock_daemon.ts ever trades.
 *
 * A stale heartbeat (faction_daemon.ts died mid-wind-down) stops counting as
 * active, so a crash can't leave the portfolio sitting in cash forever.
 */
export const INSTALL_PENDING_PATH = "/var/install_pending.txt";
export const INSTALL_PENDING_MAX_AGE_SEC = 600;

export type InstallPending = { since: number; heartbeat: number };

export function isInstallPendingActive(state: InstallPending | undefined, now: number, maxAgeSec = INSTALL_PENDING_MAX_AGE_SEC): boolean {
  return state !== undefined && now - state.heartbeat <= maxAgeSec;
}

export function readInstallPending(ns: NS): InstallPending | undefined {
  const raw = ns.read(INSTALL_PENDING_PATH);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as InstallPending;
    return typeof parsed.since === "number" && typeof parsed.heartbeat === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the wind-down, or refreshes its heartbeat if already started (keeping the original `since`). */
export function touchInstallPending(ns: NS, now: number): InstallPending {
  const state = { since: readInstallPending(ns)?.since ?? now, heartbeat: now };
  ns.write(INSTALL_PENDING_PATH, JSON.stringify(state), "w");
  return state;
}

export function clearInstallPending(ns: NS): void {
  ns.rm(INSTALL_PENDING_PATH, "home");
}
