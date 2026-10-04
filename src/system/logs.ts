import { NS } from "@ns";

export const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export type LogLevel = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];

export interface Logger {
  debug: (msg: string) => Promise<void>;
  info: (msg: string) => Promise<void>;
  warn: (msg: string) => Promise<void>;
  error: (msg: string) => Promise<void>;
}

/**
 * ns.write validates a file's actual extension (the suffix after the last
 * dot) against a fixed allow-list (.txt/.json/.css/scripts) - appending a
 * generation suffix *after* ".txt" (e.g. "foo.txt.1") produces a name whose
 * extension is ".1", which ns.write rejects outright. Inserting the suffix
 * *before* ".txt" instead keeps every log-rotation backup a valid file.
 */
export const LOG_BACKUP_SUFFIX = ".1";

export function logBackupPath(file: string): string {
  return file.endsWith(".txt") ? `${file.slice(0, -".txt".length)}${LOG_BACKUP_SUFFIX}.txt` : `${file}${LOG_BACKUP_SUFFIX}`;
}

export function isLogBackup(file: string): boolean {
  return file.endsWith(`${LOG_BACKUP_SUFFIX}.txt`);
}

/**
 * A generic, functional exponential backoff wrapper.
 * Exported so other scripts (like crawler) can use it for ports.
 */
export const withBackoff = (
  ns: NS,
  action: () => boolean,
  onRetry?: (retryCount: number, delay: number) => Promise<void>,
  retryCount = 1,
  delay = 50
): Promise<boolean> => {
  try {
    if (action()) {
      return Promise.resolve(true);
    }
  } catch (e) {
    // Treat thrown errors as retryable failures
  }

  if (retryCount >= 5) {
    return Promise.resolve(false);
  }

  const nextDelay = delay * 2;
  return (onRetry ? onRetry(retryCount, delay) : Promise.resolve())
    .then(() => ns.asleep(delay))
    .then(() => withBackoff(ns, action, onRetry, retryCount + 1, nextDelay));
};

/**
 * Creates a functional logger that dynamically names its file based on the executing script.
 */
export function createLogger(ns: NS, tag: string, minLevel: LogLevel = LOG_LEVEL.INFO): Logger {
  const host = ns.getHostname();
  const pid = ns.pid; 
  
  const rawScriptName = ns.getScriptName();
  const processName = rawScriptName.split("/").pop()?.replace(".js", "") || "unknown_process";
  const logFile = `/var/log/${host}/${processName}.txt`;

  const write = async (level: LogLevel, levelName: string, msg: string) => {
    if (level < minLevel) return;
    
    const time = new Date().toLocaleTimeString();
    const logString = `[${time}] [PID: ${pid}] [${levelName.padEnd(5)}] [${tag}] ${msg}\n`;
    
    await withBackoff(
      ns,
      () => {
        ns.write(logFile, logString, "a");
        return true; 
      },
      (retryCount) => {
        if (retryCount >= 5) ns.tprint(`CRITICAL LOG FAILURE [${logFile}]: ${logString}`);
        return Promise.resolve();
      }
    );
  };

  return {
    debug: (msg: string) => write(LOG_LEVEL.DEBUG, "DEBUG", msg),
    info:  (msg: string) => write(LOG_LEVEL.INFO,  "INFO",  msg),
    warn:  (msg: string) => write(LOG_LEVEL.WARN,  "WARN",  msg),
    error: (msg: string) => write(LOG_LEVEL.ERROR, "ERROR", msg),
  };
}