import { NS } from "@ns";
import { PORTS } from "development/types/ports";
import { Action, ActionType } from "development/types/messages";
import { ServerMetadata } from "development/types/serverMetadata";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";

const CONFIG_PATH = "/etc/supervisor.txt";

type SupervisorConfig = {
  serverListPath: string;
  dataServerDir: string;
};

// Default configuration if the config file hasn't been created yet
const DEFAULT_CONFIG: SupervisorConfig = {
  serverListPath: "/data/var/supervisor_server_list.txt",
  dataServerDir: "/data/servers/"
};

function loadConfig(ns: NS): SupervisorConfig {
  const rawConfig = ns.read(CONFIG_PATH);
  if (!rawConfig || typeof rawConfig !== "string") {
    // Automatically initialize the config file for next time
    ns.write(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "w");
    return DEFAULT_CONFIG;
  }

  try {
    const parsed = JSON.parse(rawConfig) as Partial<SupervisorConfig>;
    return {
      serverListPath: parsed.serverListPath ?? DEFAULT_CONFIG.serverListPath,
      dataServerDir: parsed.dataServerDir ?? DEFAULT_CONFIG.dataServerDir,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function loadStateFromDisk(ns: NS, config: SupervisorConfig): { state: Map<string, ServerMetadata>; hostnames: Set<string> } {
  const state = new Map<string, ServerMetadata>();
  const hostnames = new Set<string>();

  const rawList = ns.read(config.serverListPath);
  if (!rawList || typeof rawList !== "string") {
    return { state, hostnames };
  }

  let list: string[] = [];
  try {
    list = JSON.parse(rawList) as string[];
  } catch {
    return { state, hostnames };
  }

  // Ensure directory ends with a trailing slash
  const dir = config.dataServerDir.endsWith("/") ? config.dataServerDir : `${config.dataServerDir}/`;

  for (const hostname of list) {
    hostnames.add(hostname);
    const filePath = `${dir}${hostname}.txt`;
    const rawData = ns.read(filePath);
    
    if (rawData && typeof rawData === "string") {
      try {
        const server = JSON.parse(rawData) as ServerMetadata;
        state.set(server.hostname, server);
      } catch {
        // Ignore corrupted files
      }
    }
  }

  return { state, hostnames };
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Supervisor", LOG_LEVEL.INFO);
  const portId = PORTS.SERVER_METADATA;
  
  ns.clearPort(portId); 
  log.info("=== RAM-Cache Supervisor Online ===");

  // 1. Load configuration paths from /etc/supervisor.txt
  const config = loadConfig(ns);
  const dataDir = config.dataServerDir.endsWith("/") ? config.dataServerDir : `${config.dataServerDir}/`;

  // 2. In-memory state database & tracked hostnames index
  const { state: networkState, hostnames: knownHostnames } = loadStateFromDisk(ns, config);
  
  // 3. Buffer for dirty records needing a disk write
  const pendingWrites = new Map<string, ServerMetadata>();
  let listDirty = false;

  if (networkState.size > 0) {
    log.info(`[Boot] Restored ${networkState.size} servers from disk using index list.`);
  }

  log.info(`[Supervisor] Started. Listening in the background on Port ${portId}...`);

  while (true) {
    // 1. Sleep until data hits the port
    await ns.nextPortWrite(portId);

    let processedCount = 0;

    // 2. Drain the port ENTIRELY into RAM
    while (ns.peek(portId) !== "NULL PORT DATA") {
      const rawMsg = ns.readPort(portId);
      
      if (typeof rawMsg !== "string") continue;

      try {
        const action = JSON.parse(rawMsg) as Action;

        switch (action.type) {
          case ActionType.METADATA_UPDATE: {
            const server = action.payload;
            networkState.set(server.hostname, server);
            pendingWrites.set(server.hostname, server); // Queue for disk
            
            if (!knownHostnames.has(server.hostname)) {
              knownHostnames.add(server.hostname);
              listDirty = true;
            }

            processedCount++;
            break;
          }
          case ActionType.METADATA_PATCH: {
            const patch = action.payload;
            const existing = networkState.get(patch.hostname);
            
            if (existing) {
              const updated: ServerMetadata = { ...existing, ...patch };
              networkState.set(patch.hostname, updated);
              pendingWrites.set(patch.hostname, updated);
              processedCount++;
            } else {
              log.warn(`[Patch] Ignored patch for unknown server: ${patch.hostname}`);
            }
            break;
          }
          default:
            log.warn(`[Poll] Unrecognized action type.`);
        }
      } catch (err) {
        log.error(`[Poll] Failed to parse message as JSON. Flushing item.`);
      }
    }

    // 3. Flush pending writes and the index list if modified
    if (pendingWrites.size > 0) {
      for (const server of pendingWrites.values()) {
        ns.write(`${dataDir}${server.hostname}.txt`, JSON.stringify(server, null, 2), "w");
      }
      pendingWrites.clear();
    }

    if (listDirty) {
      ns.write(config.serverListPath, JSON.stringify([...knownHostnames], null, 2), "w");
      listDirty = false;
      log.debug(`[Disk] Updated master server list index (${knownHostnames.size} total servers).`);
    }

    if (processedCount > 0) {
      log.info(`[Sync] Processed ${processedCount} updates into RAM. Total nodes tracked: ${networkState.size}`);
    }
  }
}