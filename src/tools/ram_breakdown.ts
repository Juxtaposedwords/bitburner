import { NS } from "@ns";
import { scriptClosure } from "system/reload_plan";

/**
 * What a script's RAM is made of: every game function referenced anywhere
 * in it or its imports (the game charges each once, wherever it appears),
 * with its cost and the files using it - for splitting a big daemon:
 *
 *   run tools/ram_breakdown.js <script> [--out /var/claude_out/ram_breakdown.txt]
 */
export async function main(ns: NS): Promise<void> {
  const script = String(ns.args[0] ?? "");
  if (!script) {
    ns.tprint("usage: run tools/ram_breakdown.js <script> [--out <file>]");
    return;
  }
  const byFunction = new Map<string, Set<string>>();
  for (const file of scriptClosure(ns, script)) {
    const text = ns.read(file) || ns.read(`/${file}`);
    for (const m of text.matchAll(/\bns\.((?:[a-z]+\.)?[a-zA-Z0-9]+)\b/g)) {
      const name = m[1];
      if (!byFunction.has(name)) byFunction.set(name, new Set());
      byFunction.get(name)?.add(file);
    }
  }
  const rows = [...byFunction]
    .map(([name, files]) => ({ name, files: [...files], cost: ns.getFunctionRamCost(name) }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  const lines = [
    `${script}: ${ns.getScriptRam(script, "home").toFixed(2)} GB (base 1.6 + the functions below)`,
    ...rows.map((r) => `${r.cost.toFixed(2).padStart(7)} GB  ${r.name}  <- ${r.files.join(", ")}`),
    `sum of functions: ${rows.reduce((s, r) => s + r.cost, 0).toFixed(2)} GB`,
  ];
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), lines.join("\n"), "w");
  else ns.tprint(lines.join("\n"));
}
