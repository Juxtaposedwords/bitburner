import { NS, AutocompleteData } from "@ns";
import { LOG_LEVEL, LogLevel } from "../development/libraries/logs";

const DEFAULT_TAIL = 20;
const TAIL_FLAG = "-e";
const FILTER_FLAG = "-l"; // Changed from -f to allow -f for follow
const FOLLOW_FLAG = "-f";

const LEVEL_NAMES = Object.keys(LOG_LEVEL).map((k) => k.toLowerCase());

const LINE_REGEX = /^\[([^\]]+)\] \[PID: (\d+)\] \[(\w+)\s*\] \[([^\]]+)\] (.*)$/;

const RESET = "\x1b[0m";

const PROCESS_COLOR_PALETTE = [
  "\x1b[35m", // magenta
  "\x1b[32m", // green
  "\x1b[95m", // bright magenta
  "\x1b[96m", // bright cyan
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
  "\x1b[94m", // bright blue
  "\x1b[91m", // bright red
];

const COLOR = {
  host: "\x1b[36m",  // cyan
  pid: "\x1b[33m",   // yellow
  level: {
    DEBUG: "\x1b[90m", // gray
    INFO: "\x1b[34m",  // blue
    WARN: "\x1b[33m",  // yellow
    ERROR: "\x1b[31m", // red
  } as Record<string, string>,
};

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(hash);
}

function colorForProcess(processName: string): string {
  const index = hashString(processName) % PROCESS_COLOR_PALETTE.length;
  return PROCESS_COLOR_PALETTE[index];
}

function colorize(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

function colorizeLine(line: string, processColor: string): string {
  const match = line.match(LINE_REGEX);
  if (!match) return line;

  const [, time, pid, level, tag, msg] = match;
  const levelColor = COLOR.level[level] ?? RESET;

  return `[${time}] [PID: ${colorize(COLOR.pid, pid)}] [${colorize(
    levelColor,
    level.padEnd(5)
  )}] [${colorize(processColor, tag)}] ${msg}`;
}

function parseLevelArg(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toUpperCase() as keyof typeof LOG_LEVEL;
  return LOG_LEVEL[key];
}

interface ParsedArgs {
  tailLines: number;
  minFilterLevel: LogLevel | undefined;
  follow: boolean;
  rest: string[];
}

function parseArgs(rawArgs: (string | number | boolean)[]): ParsedArgs {
  const args = rawArgs.map(String);
  let tailLines = DEFAULT_TAIL;
  let minFilterLevel: LogLevel | undefined = undefined;
  let follow = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === TAIL_FLAG) {
      const next = args[i + 1];
      if (next !== undefined && !isNaN(Number(next))) {
        tailLines = Number(next);
        i++;
      } else {
        tailLines = DEFAULT_TAIL;
      }
      continue;
    }

    if (args[i] === FILTER_FLAG) {
      const next = args[i + 1];
      const level = parseLevelArg(next);
      if (level !== undefined) {
        minFilterLevel = level;
        i++;
      }
      continue;
    }

    if (args[i] === FOLLOW_FLAG) {
      follow = true;
      continue;
    }

    rest.push(args[i]);
  }

  return { tailLines, minFilterLevel, follow, rest };
}

function formatLogLines(lines: string[], processColor: string, minFilterLevel?: LogLevel): string[] {
  let filtered = lines;
  if (minFilterLevel !== undefined) {
    filtered = filtered.filter((line) => {
      const match = line.match(LINE_REGEX);
      if (!match) return false;
      const levelKey = match[3] as keyof typeof LOG_LEVEL;
      return LOG_LEVEL[levelKey] >= minFilterLevel;
    });
  }
  return filtered.map((l) => colorizeLine(l, processColor));
}

export async function main(ns: NS): Promise<void> {
  const { tailLines, minFilterLevel, follow, rest } = parseArgs(ns.args);
  const [host, process] = rest;

  if (!host || !process) {
    ns.tprint("ERROR: Invalid format.");
    ns.tprint(
      `Usage: run logger.js {hostname} {process} [${TAIL_FLAG} [n]] [${FILTER_FLAG} {level}] [${FOLLOW_FLAG}]`
    );
    ns.tprint(`Levels: ${LEVEL_NAMES.join(", ")}`);
    return;
  }

  const cleanProcess = process.replace(".js", "").replace(".txt", "");
  const logFile = `/var/log/${host}/${cleanProcess}.txt`;

  if (!ns.fileExists(logFile)) {
    ns.tprint(`[404] No log file found at: ${logFile}`);
    return;
  }

  let content = ns.read(logFile);
  let allLines = content.split("\n");
  const processColor = colorForProcess(cleanProcess);

  const initialLines = allLines.slice(-tailLines);
  const formattedInitial = formatLogLines(initialLines, processColor, minFilterLevel);

  const filterNote =
    minFilterLevel !== undefined
      ? ` (>= ${Object.keys(LOG_LEVEL).find((k) => LOG_LEVEL[k as keyof typeof LOG_LEVEL] === minFilterLevel)})`
      : "";

  ns.tprintf(
    "\n=== Logs for [%s] on [%s] (last %s lines%s) ===\n%s\n",
    colorize(processColor, cleanProcess),
    colorize(COLOR.host, host),
    String(tailLines),
    filterNote,
    logFile
  );
  
  if (formattedInitial.length > 0) {
    ns.tprintf("\n%s", formattedInitial.join("\n"));
  }

  // If follow flag isn't set, exit after printing the tail.
  if (!follow) return;

  ns.tprintf(`\n${colorize(COLOR.host, "Watching for new logs...")} (Kill script to stop)\n`);
  
  // Disable the default script logs so our sleep doesn't clutter the active scripts menu
  ns.disableLog("sleep");
  
  let lastLineCount = allLines.length;

  while (true) {
    await ns.sleep(1000);
    
    // Check if file was deleted
    if (!ns.fileExists(logFile)) continue;
    
    content = ns.read(logFile);
    let currentLines = content.split("\n");

    // File was likely truncated or reset
    if (currentLines.length < lastLineCount) {
      lastLineCount = 0;
    }

    if (currentLines.length > lastLineCount) {
      const newLines = currentLines.slice(lastLineCount);
      lastLineCount = currentLines.length;

      const formattedNew = formatLogLines(newLines, processColor, minFilterLevel);
      if (formattedNew.length > 0) {
        // Output new lines cleanly without heavy headers
        ns.tprintf("%s", formattedNew.join("\n"));
      }
    }
  }
}

export function autocomplete(data: AutocompleteData, args: string[]): string[] {
  const logFiles = data.txts
    .map((f: string) => (f.startsWith("/") ? f.slice(1) : f))
    .filter((f: string) => f.startsWith("var/log/"));

  const hostToProcesses = new Map<string, Set<string>>();

  for (const file of logFiles) {
    const parts = file.split("/");
    if (parts.length >= 4) {
      const host = parts[2];
      const process = parts[3].replace(".txt", "");
      if (!hostToProcesses.has(host)) hostToProcesses.set(host, new Set());
      hostToProcesses.get(host)!.add(process);
    }
  }

  const lastArg = args[args.length - 1];
  if (lastArg === FILTER_FLAG) {
    return LEVEL_NAMES;
  }

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === TAIL_FLAG) {
      const next = args[i + 1];
      if (next !== undefined && !isNaN(Number(next))) i++;
      continue;
    }
    if (args[i] === FILTER_FLAG) {
      const next = args[i + 1];
      if (next !== undefined && LOG_LEVEL[next?.toUpperCase() as keyof typeof LOG_LEVEL] !== undefined) i++;
      continue;
    }
    if (args[i] === FOLLOW_FLAG) {
      continue;
    }
    positional.push(args[i]);
  }

  const firstArg = positional[0];

  if (positional.length === 0 || (positional.length === 1 && !hostToProcesses.has(firstArg))) {
    return Array.from(hostToProcesses.keys());
  }

  const host = firstArg;
  const processOptions = Array.from(hostToProcesses.get(host) ?? []);
  return [...processOptions, TAIL_FLAG, FILTER_FLAG, FOLLOW_FLAG];
}