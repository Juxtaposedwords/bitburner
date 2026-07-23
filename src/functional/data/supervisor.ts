import { NS } from "@ns";
import { PORTS } from "functional/types/ports";
import { Action, ActionType } from "functional/types/messages";
import { ServerMetadata } from "functional/types/serverMetadata";
import { createLogger, LOG_LEVEL } from "tools/logs";

function loadStateFromDisk(ns: NS): Map<string, ServerMetadata> {
  const state = new Map<string, ServerMetadata>();
  const existingFiles = ns.ls("home", "/data/servers/").filter(f => f.endsWith(".txt"));
  
  for (const file of existingFiles) {
    const rawData = ns.read(file);
    if (rawData) {
      try {
        const server = JSON.parse(rawData) as ServerMetadata;
        state.set(server.hostname, server);
      } catch {
        // Ignore corrupted files
      }
    }
  }
  return state;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Supervisor", LOG_LEVEL.INFO);
  const portId = PORTS.SERVER_METADATA;
  
  ns.clearPort(portId); 
  log.info("=== RAM-Cache Supervisor Online ===");

  // 1. In-memory state database (The single source of truth)
  const networkState = loadStateFromDisk(ns);
  
  // 2. Buffer for dirty records needing a disk write (Deduplicates naturally)
  const pendingWrites = new Map<string, ServerMetadata>();

  if (networkState.size > 0) {
    log.info(`[Boot] Restored ${networkState.size} servers from disk.`);
  }

  log.info(`[Supervisor] Started. Listening in the background on Port ${portId}...`);

  while (true) {
    // 1. Sleep until data hits the port
    await ns.nextPortWrite(portId);

    let processedCount = 0;

    // 2. Drain the port ENTIRELY into RAM. 
    // Because scripts can't interrupt us while we do this, it naturally batches bursts of updates.
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

    // 3. Now that the port is empty, safely flush pending writes to disk synchronously
    if (pendingWrites.size > 0) {
      for (const server of pendingWrites.values()) {
        ns.write(`/data/servers/${server.hostname}.txt`, JSON.stringify(server, null, 2), "w");
      }
      log.debug(`[Disk] Flushed ${pendingWrites.size} deduplicated records to disk.`);
      
      // Clear the queue for the next wake cycle
      pendingWrites.clear();
    }

    if (processedCount > 0) {
      log.info(`[Sync] Processed ${processedCount} updates into RAM. Total nodes tracked: ${networkState.size}`);
    }
  }
}