import { NS, Server } from "@ns";
import { Metadata, NewClient } from "development/metadata/server_metadata";
import { createLogger, LOG_LEVEL, Logger } from "development/libraries/logs";

// --- PURE DATA TRANSFORMS ---
// comment ?
const toServerMetadata = (hostname: string, pathFromHome: string, serverInfo: Server, moneyAvailable: number): Metadata => ({
  hostname,
  organization: serverInfo.organizationName ?? "",
  ip: serverInfo.ip ?? "",
  pathFromHome,
  securityLevel: serverInfo.hackDifficulty ?? 0,
  minSecurityLevel: serverInfo.minDifficulty ?? 0,
  growthMultiplier: serverInfo.serverGrowth ?? 1,
  hacked: serverInfo.hasAdminRights ?? false,
  backdoorInstalled: serverInfo.backdoorInstalled ?? false,
  purchasedByPlayer: serverInfo.purchasedByPlayer ?? false,
  maxRam: serverInfo.maxRam ?? 0,
  ramAvailable: (serverInfo.maxRam ?? 0) - (serverInfo.ramUsed ?? 0),
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

// --- RECURSIVE MONADIC LOGIC ---

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

const createNodeProcessor = (ns: NS, log: Logger) => {
  const client = NewClient(ns);

  return (host: string, path: string): Promise<boolean> => {
    const server = toServerMetadata(host, path, ns.getServer(host), ns.getServerMoneyAvailable(host));

    return client
      .UpdateMetadata({ server })
      .then(() => log.debug(`[Streamed] ${host}`).then(() => true))
      .catch((err) => log.error(`[Drop] Failed to deliver ${host}: ${err}`).then(() => false));
  };
};

// --- IMPERATIVE SHELL (MAIN) ---

export const main = (ns: NS): Promise<void> => {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Crawler", LOG_LEVEL.DEBUG);

  return log.info("=== Starting Pure Functional Expression Crawler ===")
    .then(() => foldNetwork(ns, "home", "home", createNodeProcessor(ns, log)))
    .then(({ success, dropped, visited }) =>
      log.info(`[Complete] Streamed ${success}/${visited.size} nodes. Dropped: ${dropped}`)
    );
};