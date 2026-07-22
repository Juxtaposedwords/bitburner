import { NS } from "@ns";

export const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export type LogLevel = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Creates a functional logger that dynamically names its file based on the executing script.
 * Output example: /data/logs/home/crawler.txt
 */
export function createLogger(ns: NS, tag: string, minLevel: LogLevel = LOG_LEVEL.INFO): Logger {
  const host = ns.getHostname();
  const pid = ns.pid; // Grab the unique Process ID for this specific run
  
  const rawScriptName = ns.getScriptName();
  const processName = rawScriptName.split("/").pop()?.replace(".js", "") || "unknown_process";

  // The host is now a directory, and the process name is the file
  const logFile = `/data/logs/${host}/${processName}.txt`;

  const write = (level: LogLevel, levelName: string, msg: string) => {
    if (level < minLevel) return;
    
    const time = new Date().toLocaleTimeString();
    
    // The "a" at the end of ns.write guarantees the file is strictly appended to.
    // Injected the PID directly into the output format.
    ns.write(logFile, `[${time}] [PID: ${pid}] [${levelName.padEnd(5)}] [${tag}] ${msg}\n`, "a");
  };

  return {
    debug: (msg: string) => write(LOG_LEVEL.DEBUG, "DEBUG", msg),
    info:  (msg: string) => write(LOG_LEVEL.INFO,  "INFO",  msg),
    warn:  (msg: string) => write(LOG_LEVEL.WARN,  "WARN",  msg),
    error: (msg: string) => write(LOG_LEVEL.ERROR, "ERROR", msg),
  };
}