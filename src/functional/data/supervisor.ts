import { NS } from "@ns";
import { PORTS } from "functional/types/ports";
import { Action } from "functional/types/messages";
import { ServerMetadata } from "functional/types/serverMetadata";
import { createLogger, LOG_LEVEL } from "tools/logs";

function loadStateFromDisk(ns: NS): Map<string, ServerMetadata> {
  const state = new Map<string, ServerMetadata>();
  const existingFiles = ns.ls("home", "/data/servers/").filter(f => f.endsWith(".txt"));
  
  for (const file of existingFiles) {
    const rawData = ns.read(file);
    if (rawData) {
      const server = JSON.parse(rawData) as ServerMetadata;
      state.set(server.hostname, server);
    }
  }
  return state;
}

function saveServersToDisk(ns: NS, servers: Iterable<ServerMetadata>): void {
  for (const server of servers) {
    const filePath = `/data/servers/${server.hostname}.txt`;
    ns.write(filePath, JSON.stringify(server, null, 2), "w");
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Supervisor", LOG_LEVEL.INFO);
  
  const portId = PORTS.SERVER_METADATA;
  
  ns.clearPort(portId); 
  
  log.info("=== Functional State Supervisor ===");
  log.info(`[Boot] Online and listening on Port ${portId}...`);

  const networkState = loadStateFromDisk(ns);

  if (networkState.size > 0) {
    log.info(`[Boot] Restored ${networkState.size} servers from disk.`);
  } else {
    log.warn(`[Boot] No previous state found. Starting fresh.`);
  }

  ns.tprint(`[Supervisor] Started. Listening in the background on Port ${portId}...`);

  while (true) {
    await ns.nextPortWrite(portId);

    const serversToSave = new Set<ServerMetadata>();
    let processedCount = 0;

    while (ns.peek(portId) !== "NULL PORT DATA") {
      const rawMsg = ns.readPort(portId);
      
      if (typeof rawMsg !== "string") {
        log.warn(`[Poll] Encountered non-string port data, skipping.`);
        continue;
      }

      try {
        const action = JSON.parse(rawMsg) as Action;

        switch (action.type) {
          case "METADATA_UPDATE": {
            const server = action.payload;
            networkState.set(server.hostname, server);
            serversToSave.add(server);
            processedCount++;
            break;
          }
          case "METADATA_BATCH_UPDATE": {
            const servers = action.payload;
            for (const server of servers) {
              networkState.set(server.hostname, server);
              serversToSave.add(server);
            }
            processedCount += servers.length;
            break;
          }
          default:
            log.warn(`[Poll] Unrecognized action type received: ${(action as any).type}`);
        }
      } catch (err) {
        log.error(`[Poll] Failed to parse port message as JSON. Flushing item.`);
      }
    }

    if (serversToSave.size > 0) {
      saveServersToDisk(ns, serversToSave);
      log.info(`[Sync] Processed ${processedCount} updates. Backed up ${serversToSave.size} files to disk. Total tracked: ${networkState.size}`);
    }
  }
}