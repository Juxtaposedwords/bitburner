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

/**
 * `phase`: "augments" (the default) while stock is sold and cash goes to
 * augmentations; "spendDown" once nothing is left to buy there - then
 * cash goes to what survives an install (gang equipment via gang_daemon.ts,
 * home RAM via faction_daemon.ts) until spending settles, and only then
 * the install happens. `spendDown` tracks that settling (advanceSpendDown).
 */
export type InstallPending = { since: number; heartbeat: number; phase?: "augments" | "spendDown"; spendDown?: SpendDownState };

/** Cash while spending down: when it started, the last cash seen, and when cash last dropped (ms). */
export type SpendDownState = { since: number; lastCash: number; lastDropAt: number };

/** Records this tick's cash; a drop means something was bought, so the settle clock restarts. */
export function advanceSpendDown(state: SpendDownState | undefined, cash: number, nowMs: number): SpendDownState {
  if (!state) return { since: nowMs, lastCash: cash, lastDropAt: nowMs };
  return { since: state.since, lastCash: cash, lastDropAt: cash < state.lastCash ? nowMs : state.lastDropAt };
}

/** Spending has settled once cash hasn't dropped for `settleMs` - nothing affordable is left to buy. */
export function spendDownSettled(state: SpendDownState, nowMs: number, settleMs: number): boolean {
  return nowMs - state.lastDropAt >= settleMs;
}

/** Whether the spend-down stage is running (and its writer is alive). */
export function isSpendDownActive(state: InstallPending | undefined, now: number, maxAgeSec = INSTALL_PENDING_MAX_AGE_SEC): boolean {
  return isInstallPendingActive(state, now, maxAgeSec) && state?.phase === "spendDown";
}

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

/** Starts the wind-down, or refreshes its heartbeat if already started (keeping `since`, the phase, and spend-down progress). */
export function touchInstallPending(ns: NS, now: number): InstallPending {
  const existing = readInstallPending(ns);
  const state = { ...existing, since: existing?.since ?? now, heartbeat: now };
  ns.write(INSTALL_PENDING_PATH, JSON.stringify(state), "w");
  return state;
}

export function clearInstallPending(ns: NS): void {
  ns.rm(INSTALL_PENDING_PATH, "home");
}

/** Writes the whole wind-down state (faction_daemon.ts's spend-down stage). */
export function writeInstallPending(ns: NS, state: InstallPending): void {
  ns.write(INSTALL_PENDING_PATH, JSON.stringify(state), "w");
}
