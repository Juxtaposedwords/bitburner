import { NS } from "@ns";
import { isLogBackup } from "development/libraries/logs";

const LOG_DIR = "/var/log/";
const DEFAULT_TAIL = 200;
// Deliberately outside LOG_DIR (no "/var/log/" substring) so a re-run's
// ns.ls(host, LOG_DIR) scan never picks up its own previous output.
const DEFAULT_OUTPUT = "/var/log_dump.txt";

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

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const { tailLines, includeBackups, output } = parseArgs(ns.args);

  const host = ns.getHostname();
  const logFiles = ns
    .ls(host, LOG_DIR)
    .filter((f) => f !== output && f.endsWith(".txt"))
    .filter((f) => includeBackups || !isLogBackup(f))
    .sort();

  if (logFiles.length === 0) {
    ns.tprint(`[DumpLogs] No log files found under ${LOG_DIR} on ${host}.`);
    return;
  }

  const files = logFiles.map((path) => ({ path, content: ns.read(path) }));
  const dump = buildDump(files, tailLines);

  ns.write(output, dump, "w");
  ns.tprint(
    `[DumpLogs] Wrote ${logFiles.length} file(s) (last ${Number.isFinite(tailLines) ? tailLines : "all"} lines each) to ${output}. ` +
      `Open it in the Script Editor and copy its contents (Ctrl+A, Ctrl+C).`
  );
}
