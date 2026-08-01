import { NS } from "@ns";

// Runtime data only — never /etc/, so configs survive a wipe and don't need
// to be recreated by hand before the next test run.
const WIPE_PREFIXES = ["/var/log/", "/var/supervisor/"];

export async function main(ns: NS): Promise<void> {
  const host = ns.getHostname();
  let removed = 0;

  for (const prefix of WIPE_PREFIXES) {
    for (const file of ns.ls(host, prefix)) {
      if (ns.rm(file, host)) removed++;
    }
  }

  ns.tprint(`[Wipe] Removed ${removed} file(s) under ${WIPE_PREFIXES.join(", ")} on ${host}.`);
}
