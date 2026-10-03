import { NS } from "@ns";

/**
 * Recently finished scripts with their last log lines - the crash errors
 * the game shows in pop-ups, as a file:
 *
 *   run tools/recent_scripts.js [--out /var/claude_out/recent_scripts.txt]
 */
export async function main(ns: NS): Promise<void> {
  const lines: string[] = [];
  for (const r of ns.getRecentScripts()) {
    lines.push(`== ${r.filename} ${JSON.stringify(r.args)} on ${r.server} (pid ${r.pid}, ended ${new Date(r.timeOfDeath).toLocaleTimeString()})`);
    for (const l of r.logs.slice(-8)) lines.push(`   ${String(l).slice(0, 300)}`);
  }
  const text = lines.join("\n") || "(no recently finished scripts)";
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), text, "w");
  else ns.tprint(text);
}
