import { NS } from "@ns";

/**
 * What recently finished batch workers actually did, from the logs the game
 * keeps for them (ns.getRecentScripts):
 *
 *   run tools/worker_probe.js [hack|grow|weaken, default hack]
 *
 * Tallies successes, failures and money for the chosen worker, and prints
 * a few raw log lines - for when batches fire but income doesn't move.
 */
export async function main(ns: NS): Promise<void> {
  const kind = String(ns.args[0] ?? "hack");
  const file = `hacking/workers/${kind}_worker.js`;
  const recent = ns.getRecentScripts().filter((r) => r.filename.replace(/^\//, "") === file);
  if (recent.length === 0) {
    ns.tprint(`No finished ${file} in the recent-scripts list (Options > "Recently killed scripts size" keeps it short).`);
    return;
  }

  let ok = 0;
  let failed = 0;
  let money = 0;
  let other = 0;
  const samples: string[] = [];
  for (const r of recent) {
    const lines = r.logs.map(String);
    const result = lines.find((l) => /hack|grow|weaken/i.test(l) && /(Successfully|Failed|Executing|increased|reduced|by)/i.test(l)) ?? lines[lines.length - 1] ?? "(empty log)";
    if (/Failed/i.test(result)) failed++;
    else if (/Successfully/i.test(result)) {
      ok++;
      const m = /\$([\d.,]+)\s*([kmbtq]?)/i.exec(result);
      if (m) money += Number(m[1].replace(/,/g, "")) * ({ "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 }[m[2].toLowerCase()] ?? 1);
    } else other++;
    if (samples.length < 6) samples.push(`  [${r.server} x${r.threads} args=${JSON.stringify(r.args)}] ${lines.slice(-3).join(" | ")}`);
  }

  ns.tprintf(
    "%s",
    [
      `${recent.length} finished ${kind} worker(s): ${ok} succeeded, ${failed} failed, ${other} unclear` +
        (kind === "hack" ? `, ~$${money.toExponential(2)} taken in total` : ""),
      "sample logs:",
      ...samples,
    ].join("\n")
  );
}
