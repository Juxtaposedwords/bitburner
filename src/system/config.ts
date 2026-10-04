import { NS } from "@ns";

/**
 * Loads a JSON config file of overrides on top of `defaults` (a missing
 * file means all defaults - nothing is written), and falls back to
 * `defaults` entirely on corrupt JSON.
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
  if (!raw) return defaults;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    ns.tprint(`[loadJsonConfig] ERROR: ${path} has invalid JSON, falling back to defaults entirely: ${error}`);
    return defaults;
  }
  // The file holds overrides only: a key equal to its default is dropped
  // (and the file rewritten without it), so a changed default reaches every
  // install. Writing all defaults out used to pin old values - share at 0.5,
  // sleeve saving at 60 minutes, stale hacknet keys - long after the code
  // moved on.
  const overrides = stripDefaults(parsed, defaults as Record<string, unknown>);
  if (Object.keys(overrides).length !== Object.keys(parsed).length) ns.write(path, JSON.stringify(overrides, null, 2), "w");
  return { ...defaults, ...(overrides as Partial<T>) };
}

/** `config` without the keys whose value equals `defaults`' (compared as JSON). Keys not in `defaults` stay. */
export function stripDefaults(config: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => !(key in defaults) || JSON.stringify(value) !== JSON.stringify(defaults[key])));
}
