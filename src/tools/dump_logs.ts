import { NS } from "@ns";
import { isLogBackup } from "development/libraries/logs";

const LOG_DIR = "/var/log/";
const DEFAULT_TAIL = 200;
// Deliberately outside LOG_DIR (no "/var/log/" substring) so a re-run's
// ns.ls(host, LOG_DIR) scan never picks up its own previous output.
export const DEFAULT_OUTPUT = "/var/log_dump.txt";

interface ParsedArgs {
  tailLines: number;
  includeBackups: boolean;
  output: string;
}

function parseArgs(rawArgs: (string | number | boolean)[]): ParsedArgs {
  const args = rawArgs.map(String);
  let tailLines: number = DEFAULT_TAIL;
  let includeBackups = false;
  let output = DEFAULT_OUTPUT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail") {
      const next = args[i + 1];
      if (next !== undefined && !isNaN(Number(next))) {
        tailLines = Number(next);
        i++;
      }
    } else if (args[i] === "--all") {
      tailLines = Infinity;
    } else if (args[i] === "--include-backups") {
      includeBackups = true;
    } else if (args[i] === "--out") {
      const next = args[i + 1];
      if (next !== undefined) {
        output = next;
        i++;
      }
    }
  }

  return { tailLines, includeBackups, output };
}

/**
 * Pure: given every log file's raw content, build one paste-ready blob —
 * a header per file (path + line count, noting how many were omitted by
 * the tail cutoff) followed by its lines, in the order given.
 */
export function buildDump(files: { path: string; content: string }[], tailLines: number): string {
  const sections = files.map(({ path, content }) => {
    const lines = content.split("\n").filter((line) => line.length > 0);
    const tail = Number.isFinite(tailLines) ? lines.slice(-tailLines) : lines;
    const omitted = lines.length - tail.length;
    const header = `=== ${path} (${tail.length}${omitted > 0 ? ` of ${lines.length}` : ""} lines) ===`;
    return `${header}\n${tail.length > 0 ? tail.join("\n") : "(empty)"}`;
  });
  return sections.join("\n\n");
}

/**
 * Lists every log file on `host`, builds the combined dump, and writes it
 * to `output`. Returns the number of files included (0 means nothing was
 * written). Extracted so tools/test_restart.ts can reuse it without
 * spawning a subprocess.
 */
export function collectAndWriteDump(ns: NS, host: string, tailLines: number, includeBackups: boolean, output: string): number {
  const logFiles = ns
    .ls(host, LOG_DIR)
    .filter((f) => f !== output && f.endsWith(".txt"))
    .filter((f) => includeBackups || !isLogBackup(f))
    .sort();

  if (logFiles.length === 0) return 0;

  const files = logFiles.map((path) => ({ path, content: ns.read(path) }));
  ns.write(output, buildDump(files, tailLines), "w");
  return logFiles.length;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const { tailLines, includeBackups, output } = parseArgs(ns.args);

  const host = ns.getHostname();
  const fileCount = collectAndWriteDump(ns, host, tailLines, includeBackups, output);

  if (fileCount === 0) {
    ns.tprint(`[DumpLogs] No log files found under ${LOG_DIR} on ${host}.`);
    return;
  }

  ns.tprint(
    `[DumpLogs] Wrote ${fileCount} file(s) (last ${Number.isFinite(tailLines) ? tailLines : "all"} lines each) to ${output}. ` +
      `Open it in the Script Editor and copy its contents (Ctrl+A, Ctrl+C).`
  );
}
