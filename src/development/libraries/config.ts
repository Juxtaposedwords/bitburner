import { NS } from "@ns";

/**
 * Loads a JSON config file, writing `defaults` out if the file doesn't
 * exist yet, filling in any fields missing from a partially-edited file,
 * and falling back to `defaults` entirely on corrupt JSON.
 */
export function loadJsonConfig<T extends object>(ns: NS, path: string, defaults: T): T {
  const raw = ns.read(path);
  if (!raw) {
    ns.write(path, JSON.stringify(defaults, null, 2), "w");
    return defaults;
  }
  try {
    return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return defaults;
  }
}
