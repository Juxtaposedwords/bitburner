import { NS } from "@ns";
import { MANAGED_DAEMONS } from "system/reload_plan";

/**
 * Home RAM: total, used, and each managed daemon's cost and whether it runs:
 *
 *   run tools/ram_report.js [--out /var/claude_out/ram_report.txt]
 */
export async function main(ns: NS): Promise<void> {
  const running = new Set(ns.ps("home").map((p) => p.filename.replace(/^\//, "")));
  const lines = [`home: ${ns.getServerUsedRam("home").toFixed(1)} of ${ns.getServerMaxRam("home").toFixed(1)} GB used`];
  let all = 0;
  for (const script of MANAGED_DAEMONS) {
    const ram = ns.getScriptRam(script, "home");
    all += ram;
    lines.push(`  ${running.has(script) ? "running" : "STOPPED"}  ${ram.toFixed(1).padStart(7)} GB  ${script}`);
  }
  lines.push(`all managed daemons together: ${all.toFixed(1)} GB`);
  const workers = ns
    .ps("home")
    .filter((p) => /_worker\.js$/.test(p.filename))
    .reduce((sum, p) => sum + ns.getScriptRam(p.filename, "home") * p.threads, 0);
  lines.push(`workers on home: ${workers.toFixed(1)} GB`);
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), lines.join("\n"), "w");
  else ns.tprint(lines.join("\n"));
}
