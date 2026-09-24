import { NS } from "@ns";

/**
 * Loads a JSON config file, writing `defaults` out if the file doesn't
 * exist yet, filling in any fields missing from a partially-edited file,
 * and falling back to `defaults` entirely on corrupt JSON.
 *
 * The corrupt-JSON fallback used to be silent - every daemon calling this
 * (hacknet/purchased-server/faction/gang, plus their state files) would
 * quietly revert ALL fields to defaults on a syntax error (e.g. a
 * trailing comma after hand-editing), with no indication anywhere that
 * it happened - caught live when a config edit that should have taken
 * effect silently didn't. ns.tprint is 0 GB (same free tier as
 * ns.read/ns.write) and already this codebase's convention for loud,
 * Logger-independent errors (see boot.ts's own ERROR lines), so this
 * needs no signature change and no threading a Logger through every one
 * of this function's callers to get real visibility.
 */
export function loadJsonConfig<T extends object>(ns: NS, path: string, defaults: T): T {
  const raw = ns.read(path);
  if (!raw) {
    ns.write(path, JSON.stringify(defaults, null, 2), "w");
    return defaults;
  }
  try {
    return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
  } catch (error) {
    ns.tprint(`[loadJsonConfig] ERROR: ${path} has invalid JSON, falling back to defaults entirely: ${error}`);
    return defaults;
  }
}
