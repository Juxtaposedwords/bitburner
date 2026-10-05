/**
 * A point in time a call must be done by, passed down the stack by whoever
 * asked - the same idea as gRPC's deadlines. The caller says how long it
 * has; each layer passes it on (or a nearer one for a sub-step, never a
 * later one), and work that runs over stops with the best it has so far
 * instead of every layer guessing a timeout of its own. Used by RPC calls
 * (system/rpc/rpc.ts carries it in the envelope, so a server sees the
 * caller's budget) and by computation that can stop early (IPvGO move
 * choice, go/). An absolute Date.now() time, so it means the same thing
 * in every script.
 */
export type Deadline = { readonly at: number };

/** `ms` from now. */
export function deadlineIn(ms: number, now = Date.now()): Deadline {
  return { at: now + ms };
}

/** Never expires - for callers with no budget. */
export const NO_DEADLINE: Deadline = { at: Infinity };

export function expired(deadline: Deadline | undefined, now = Date.now()): boolean {
  return deadline !== undefined && now >= deadline.at;
}

export function remainingMs(deadline: Deadline, now = Date.now()): number {
  return Math.max(0, deadline.at - now);
}

/** A sub-step's deadline: `ms` from now, but never past the parent's. */
export function within(parent: Deadline | undefined, ms: number, now = Date.now()): Deadline {
  return { at: Math.min(parent?.at ?? Infinity, now + ms) };
}

/** A deadline from what callers pass: a Deadline as is, a number as milliseconds from now. */
export function toDeadline(arg: Deadline | number, now = Date.now()): Deadline {
  return typeof arg === "number" ? deadlineIn(arg, now) : arg;
}
