import { NS, Server } from "@ns";
import { PORTS } from "functional/types/ports";
import { Action } from "functional/types/messages";
import { ServerMetadata } from "functional/types/serverMetadata";
import { createLogger, LOG_LEVEL } from "tools/logs";

// --- PURE DATA TRANSFORMS ---

const toServerMetadata = (hostname: string, pathFromHome: string, serverInfo: Server, moneyAvailable: number): ServerMetadata => ({
  hostname,
  organization: serverInfo.organizationName ?? "",
  ip: serverInfo.ip ?? "",
  pathFromHome,
  securityLevel: serverInfo.hackDifficulty ?? 0,
  minSecurityLevel: serverInfo.minDifficulty ?? 0,
  hacked: serverInfo.hasAdminRights ?? false,
  backdoorInstalled: serverInfo.backdoorInstalled ?? false,
  purchasedByPlayer: serverInfo.purchasedByPlayer ?? false,
  maxRam: serverInfo.maxRam ?? 0,
  cpuCores: serverInfo.cpuCores ?? 1,
  hacking: {
    requirements: { level: serverInfo.requiredHackingSkill, ports: serverInfo.numOpenPortsRequired },
    ports: {
      ssh: serverInfo.sshPortOpen ?? false,
      ftp: serverInfo.ftpPortOpen ?? false,
      smtp: serverInfo.smtpPortOpen ?? false,
      http: serverInfo.httpPortOpen ?? false,
      sql: serverInfo.sqlPortOpen ?? false,
    },
  },
  moneyAvailable,
  maxMoney: serverInfo.moneyMax,
});

type FoldState = { readonly visited: ReadonlySet<string>; readonly success: number; readonly dropped: number; };

// --- RECURSIVE MONADIC LOGIC (Expression-Oriented) ---

// Pure recursive expression using ternaries and Promise chaining (no async/await statements)
const writeWithBackoff = (ns: NS, portId: number, action: Action, log: any, attempt = 1, delay = 50): Promise<boolean> =>
  ns.tryWritePort(portId, JSON.stringify(action))
    ? Promise.resolve(true)
    : attempt >= 5
      ? Promise.resolve(false)
      : (
          log.warn(`[Backoff] Port ${portId} full. Retrying attempt ${attempt}/5 in ${delay}ms...`),
          ns.sleep(delay).then(() => writeWithBackoff(ns, portId, action, log, attempt + 1, delay * 2))
        );

// The monadic fold (equivalent to foldM). Evaluates entirely as a single expression.
const foldNetwork = (
  ns: NS,
  currentHost: string,
  currentPath: string,
  processFn: (host: string, path: string) => Promise<boolean>,
  state: FoldState = { visited: new Set(), success: 0, dropped: 0 }
): Promise<FoldState> =>
  state.visited.has(currentHost)
    ? Promise.resolve(state)
    : processFn(currentHost, currentPath).then(delivered =>
        ns.scan(currentHost).reduce<Promise<FoldState>>(
          (accPromise, neighbor) =>
            accPromise.then(accState =>
              foldNetwork(ns, neighbor, `${currentPath} -> ${neighbor}`, processFn, accState)
            ),
          Promise.resolve<FoldState>({
            visited: new Set([...state.visited, currentHost]),
            success: state.success + (delivered ? 1 : 0),
            dropped: state.dropped + (delivered ? 0 : 1),
          })
        )
      );

// Curried higher-order function: injects dependencies (ns, port, log) first, returns the processing function
const createNodeProcessor = (ns: NS, portId: number, log: any) => (host: string, path: string): Promise<boolean> =>
  writeWithBackoff(
    ns,
    portId,
    { type: "METADATA_UPDATE", payload: toServerMetadata(host, path, ns.getServer(host), ns.getServerMoneyAvailable(host)) },
    log
  ).then(success => (
    success ? log.debug(`[Streamed] ${host}`) : log.error(`[Drop] Failed to deliver ${host} after max retries.`),
    success
  ));

// --- IMPERATIVE SHELL (MAIN) ---

export const main = (ns: NS): Promise<void> => {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Crawler", LOG_LEVEL.DEBUG);
  log.info("=== Starting Pure Functional Expression Crawler ===");

  // Kick off the monadic pipeline. No intermediate variables are used.
  return foldNetwork(ns, "home", "home", createNodeProcessor(ns, PORTS.SERVER_METADATA, log))
    .then(({ success, dropped, visited }) => {
      log.info(`[Complete] Streamed ${success}/${visited.size} nodes. Dropped: ${dropped}`);
    });
};