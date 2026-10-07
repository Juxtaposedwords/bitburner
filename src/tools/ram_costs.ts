import { NS } from "@ns";

/**
 * Every game function's RAM cost, as this game charges it (Source-Files
 * change some), for build/ram_estimate.mjs - which sizes scripts offline
 * the way the game does:
 *
 *   run tools/ram_costs.js [--out /var/claude_out/ram_costs.txt]
 *
 * Walks the ns object: top-level functions first, then each namespace.
 */
export async function main(ns: NS): Promise<void> {
  const costs: { path: string; cost: number }[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
    const keys = Object.keys(obj);
    for (const key of keys) if (typeof obj[key] === "function") costs.push({ path: prefix + key, cost: priced(ns, prefix + key) });
    if (depth >= 2) return;
    for (const key of keys) {
      const value = obj[key];
      if (value && typeof value === "object" && key !== "args" && key !== "enums") walk(value as Record<string, unknown>, `${prefix}${key}.`, depth + 1);
    }
  };
  walk(ns as unknown as Record<string, unknown>, "", 0);
  const text = JSON.stringify(costs.filter((c) => c.cost > 0));
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), text, "w");
  else ns.tprint(text);
}

function priced(ns: NS, path: string): number {
  try {
    return ns.getFunctionRamCost(path);
  } catch {
    return 0;
  }
}
