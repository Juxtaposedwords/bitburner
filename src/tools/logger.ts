import { NS, AutocompleteData } from "@ns";
import { LOG_LEVEL, LogLevel } from "/tools/logs";

const DEFAULT_TAIL = 20;
const TAIL_FLAG = "-e";
const FILTER_FLAG = "-f";

const LEVEL_NAMES = Object.keys(LOG_LEVEL).map((k) => k.toLowerCase());

const LINE_REGEX = /^\[([^\]]+)\] \[PID: (\d+)\] \[(\w+)\s*\] \[([^\]]+)\] (.*)$/;

const RESET = "\x1b[0m";

// Fixed palette to pick process colors from. Avoids DEBUG/INFO/WARN/ERROR's
// colors so process coloring doesn't visually collide with level coloring.
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

/** Simple deterministic string hash (djb2) so the same process name always maps to the same color. */
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

  // tag is the label passed into createLogger — colored with the same
  // per-process color as the header for visual consistency.
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
  rest: string[];
}

function parseArgs(rawArgs: (string | number | boolean)[]): ParsedArgs {
  const args = rawArgs.map(String);
  let tailLines = DEFAULT_TAIL;
  let minFilterLevel: LogLevel | undefined = undefined;
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

    rest.push(args[i]);
  }

  return { tailLines, minFilterLevel, rest };
}

export async function main(ns: NS): Promise<void> {
  const { tailLines, minFilterLevel, rest } = parseArgs(ns.args);
  const [host, process] = rest;

  if (!host || !process) {
    ns.tprint("ERROR: Invalid format.");
    ns.tprint(
      `Usage: run logger.js {hostname} {process} [${TAIL_FLAG} [n]] [${FILTER_FLAG} {level}]`
    );
    ns.tprint(`Levels: ${LEVEL_NAMES.join(", ")}`);
    return;
  }

  const cleanProcess = process.replace(".js", "").replace(".txt", "");
  const logFile = `/data/logs/${host}/${cleanProcess}.txt`;

  if (!ns.fileExists(logFile)) {
    ns.tprint(`[404] No log file found at: ${logFile}`);
    return;
  }

  const content = ns.read(logFile);
  let lines = content.split("\n");

  if (minFilterLevel !== undefined) {
    lines = lines.filter((line) => {
      const match = line.match(LINE_REGEX);
      if (!match) return false;
      const levelKey = match[3] as keyof typeof LOG_LEVEL;
      return LOG_LEVEL[levelKey] >= minFilterLevel;
    });
  }

  const processColor = colorForProcess(cleanProcess);
  const trimmedLines = lines.slice(-tailLines);
  const coloredOutput = trimmedLines.map((l) => colorizeLine(l, processColor)).join("\n");

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
  ns.tprintf("\n%s", coloredOutput);
}

export function autocomplete(data: AutocompleteData, args: string[]): string[] {
  const logFiles = data.txts
    .map((f: string) => (f.startsWith("/") ? f.slice(1) : f))
    .filter((f: string) => f.startsWith("data/logs/"));

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
    positional.push(args[i]);
  }

  const firstArg = positional[0];

  if (positional.length === 0 || (positional.length === 1 && !hostToProcesses.has(firstArg))) {
    return Array.from(hostToProcesses.keys());
  }

  const host = firstArg;
  const processOptions = Array.from(hostToProcesses.get(host) ?? []);
  return [...processOptions, TAIL_FLAG, FILTER_FLAG];
}