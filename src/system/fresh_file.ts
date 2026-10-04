import { NS } from "@ns";

/**
 * A JSON status file another daemon rewrites every tick, or undefined when
 * it's missing, unreadable, or older than `maxAgeMs` - a stopped writer's
 * stale flags shouldn't steer anything.
 */
export function readFreshJson<T extends { writtenAt: number }>(ns: NS, path: string, maxAgeMs: number): T | undefined {
  const raw = ns.read(path);
  if (!raw) return undefined;
  try {
    const file = JSON.parse(raw) as T;
    return Date.now() - file.writtenAt <= maxAgeMs ? file : undefined;
  } catch {
    return undefined;
  }
}
