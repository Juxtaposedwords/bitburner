import { NS } from "@ns";
import { decideReloads, fingerprint, MANAGED_DAEMONS, Tracked } from "development/libraries/reload_plan";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";

/**
 * Restarts a running daemon when its code changes (see reload_plan.ts): new
 * builds reach the game as files through bitburner-filesync, but a running
 * script keeps the code it started with. Every CHECK_INTERVAL_MS it
 * fingerprints each managed daemon on home (its file plus everything it
 * imports) and restarts - kill, then run with the same threads and
 * arguments - any whose fingerprint changed and then held for one check.
 *
 * Never touches workers, one-shot tools, bootstrap, or itself (a change to
 * the reloader itself still needs a manual restart). Small on purpose
 * (ps/kill/run/read): boot.js starts it with the first daemons.
 */
const CHECK_INTERVAL_MS = 10_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Reloader", LOG_LEVEL.INFO);
  await log.info("=== Reloader online ===");

  let tracked = new Map<number, Tracked>();
  while (true) {
    const processes = ns.ps("home").filter((p) => MANAGED_DAEMONS.includes(p.filename.replace(/^\//, "")));
    const sources = new Map<string, string>();
    // An unreadable path counts as an empty file rather than crashing the loop.
    const read = (path: string): string => {
      if (!sources.has(path)) {
        let source = "";
        try {
          source = ns.read(path) || ns.read(`/${path}`);
        } catch {
          source = "";
        }
        sources.set(path, source);
      }
      return sources.get(path) as string;
    };
    const decision = decideReloads(
      tracked,
      processes.map((p) => ({ pid: p.pid, signature: fingerprint(p.filename.replace(/^\//, ""), read) }))
    );
    tracked = decision.tracked;

    for (const pid of decision.restart) {
      const p = processes.find((proc) => proc.pid === pid);
      if (!p) continue;
      ns.kill(pid);
      const newPid = ns.run(p.filename, p.threads, ...p.args);
      if (newPid === 0) await log.warn(`[Reloader] ${p.filename} changed; killed it but couldn't restart it (RAM?).`);
      else await log.info(`[Reloader] ${p.filename} changed; restarted (pid ${pid} -> ${newPid}).`);
    }

    await ns.asleep(CHECK_INTERVAL_MS);
  }
}
