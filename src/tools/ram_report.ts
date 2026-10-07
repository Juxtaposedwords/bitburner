import { NS } from "@ns";
import { MANAGED_DAEMONS } from "system/reload_plan";
import { daemonHosts } from "system/remote_state";

/**
 * Home RAM: total, used, and each managed daemon's cost and whether it runs:
 *
 *   run tools/ram_report.js [--out /var/claude_out/ram_report.txt]
 */
export async function main(ns: NS): Promise<void> {
  // Where each managed daemon runs: home, or a daemon host (system/remote_state.ts).
  const where = new Map<string, string>();
  for (const host of ["home", ...daemonHosts(ns).filter((h) => ns.serverExists(h))]) {
    for (const p of ns.ps(host)) where.set(p.filename.replace(/^\//, ""), host);
  }
  const lines = [`home: ${ns.getServerUsedRam("home").toFixed(1)} of ${ns.getServerMaxRam("home").toFixed(1)} GB used`];
  let all = 0;
  for (const script of MANAGED_DAEMONS) {
    const ram = ns.getScriptRam(script, "home");
    all += ram;
    const host = where.get(script);
    lines.push(`  ${host ? "running" : "STOPPED"}  ${ram.toFixed(1).padStart(7)} GB  ${script}${host && host !== "home" ? `  (on ${host})` : ""}`);
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
