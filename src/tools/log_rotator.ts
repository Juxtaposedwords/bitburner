import { NS } from "@ns";

const LOG_DIR_SUBSTRING = "/var/log/";
const BACKUP_SUFFIX = ".1";
const MAX_LOG_SIZE_BYTES = 100_000;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Unix logrotate's "copytruncate": copy the file's full contents to the
 * backup (overwriting any prior one), then truncate the original in place.
 *
 * Bitburner's ns.read/ns.write resolve by path on every call rather than
 * through a persistent file handle, so — unlike real Unix — there's no risk
 * of a writer's next append landing on a renamed-away file; copytruncate is
 * used here for the familiar "keep one backup generation" semantics, not to
 * work around a handle-following problem that doesn't exist in Bitburner.
 */
export function rotateIfNeeded(ns: NS, file: string): void {
  const content = ns.read(file);
  if (content.length <= MAX_LOG_SIZE_BYTES) return;

  ns.write(`${file}${BACKUP_SUFFIX}`, content, "w");
  ns.write(file, "", "w");
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  while (true) {
    const host = ns.getHostname();
    const logFiles = ns.ls(host, LOG_DIR_SUBSTRING).filter((file) => !file.endsWith(BACKUP_SUFFIX));

    for (const file of logFiles) {
      rotateIfNeeded(ns, file);
    }

    await ns.asleep(SWEEP_INTERVAL_MS);
  }
}
