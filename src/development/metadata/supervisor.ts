import { NS } from "@ns";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { NewServer } from "development/libraries/rpc";
import {
  ActionResponse,
  Metadata,
  PatchMetadataRequest,
  RegisterSupervisor,
  SupervisorHandlers,
  SupervisorPort,
  UpdateMetadataRequest,
} from "development/metadata/server_metadata";

const CONFIG_PATH = "/etc/supervisor.txt";

/** How often dirty records are flushed to disk. Handlers never touch the filesystem. */
const FLUSH_INTERVAL_MS = 1000;

export type SupervisorConfig = {
  serverListPath: string;
  dataServerDir: string;
};

// Default configuration if the config file hasn't been created yet
const DEFAULT_CONFIG: SupervisorConfig = {
  serverListPath: "/data/var/supervisor_server_list.txt",
  dataServerDir: "/data/servers/",
};

export const withTrailingSlash = (dir: string): string => (dir.endsWith("/") ? dir : `${dir}/`);

export function loadConfig(ns: NS): SupervisorConfig {
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

export function loadStateFromDisk(
  ns: NS,
  config: SupervisorConfig
): { state: Map<string, Metadata>; hostnames: Set<string> } {
  const state = new Map<string, Metadata>();
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

  const dir = withTrailingSlash(config.dataServerDir);

  for (const hostname of list) {
    hostnames.add(hostname);
    const filePath = `${dir}${hostname}.txt`;
    const rawData = ns.read(filePath);
    if (rawData && typeof rawData === "string") {
      try {
        const server = JSON.parse(rawData) as Metadata;
        if (server?.hostname) state.set(server.hostname, server);
      } catch {
        // Ignore corrupted files
      }
    }
  }

  return { state, hostnames };
}

/**
 * Shallow merge that ignores explicitly-undefined fields.
 *
 * Proto3 `optional` fields arrive as `undefined` when unset, so a plain
 * `{ ...existing, ...patch }` would clobber good values with undefined.
 */
export function mergeDefined(base: Metadata, patch: Metadata): Metadata {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Metadata;
}

/** All of the supervisor's RAM-resident, mutable state. */
export type SupervisorState = {
  networkState: Map<string, Metadata>;
  knownHostnames: Set<string>;
  pendingWrites: Map<string, Metadata>;
  listDirty: boolean;
  processedSinceFlush: number;
};

export function createSupervisorState(
  networkState: Map<string, Metadata> = new Map(),
  knownHostnames: Set<string> = new Set()
): SupervisorState {
  return { networkState, knownHostnames, pendingWrites: new Map(), listDirty: false, processedSinceFlush: 0 };
}

/**
 * Builds the RPC handlers. These stay synchronous and RAM-only so the
 * caller's round trip is cheap — durability is `flush`'s job, not theirs.
 */
export function createHandlers(log: Logger, state: SupervisorState): SupervisorHandlers {
  return {
    UpdateMetadata: (req: UpdateMetadataRequest): ActionResponse => {
      const server = req.server;
      if (!server?.hostname) {
        throw new Error("UpdateMetadata: request.server.hostname is required");
      }

      state.networkState.set(server.hostname, server);
      state.pendingWrites.set(server.hostname, server);

      if (!state.knownHostnames.has(server.hostname)) {
        state.knownHostnames.add(server.hostname);
        state.listDirty = true;
      }

      state.processedSinceFlush++;
      return { success: true };
    },

    PatchMetadata: async (req: PatchMetadataRequest): Promise<ActionResponse> => {
      const patch = req.server;
      if (!patch?.hostname) {
        throw new Error("PatchMetadata: request.server.hostname is required");
      }

      const existing = state.networkState.get(patch.hostname);
      if (!existing) {
        await log.warn(`[Patch] Ignored patch for unknown server: ${patch.hostname}`);
        return { success: false };
      }

      const updated = mergeDefined(existing, patch);
      state.networkState.set(patch.hostname, updated);
      state.pendingWrites.set(patch.hostname, updated);

      state.processedSinceFlush++;
      return { success: true };
    },
  };
}

export async function flush(
  ns: NS,
  log: Logger,
  config: SupervisorConfig,
  dataDir: string,
  state: SupervisorState
): Promise<void> {
  // Snapshot-and-clear is synchronous, so no handler can interleave here.
  if (state.pendingWrites.size > 0) {
    for (const server of state.pendingWrites.values()) {
      ns.write(`${dataDir}${server.hostname}.txt`, JSON.stringify(server, null, 2), "w");
    }
    state.pendingWrites.clear();
  }

  if (state.listDirty) {
    state.listDirty = false;
    ns.write(config.serverListPath, JSON.stringify([...state.knownHostnames], null, 2), "w");
    await log.debug(`[Disk] Updated master server list index (${state.knownHostnames.size} total servers).`);
  }

  if (state.processedSinceFlush > 0) {
    const count = state.processedSinceFlush;
    state.processedSinceFlush = 0;
    await log.info(`[Sync] Processed ${count} updates into RAM. Total nodes tracked: ${state.networkState.size}`);
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Supervisor", LOG_LEVEL.INFO);

  const portId = SupervisorPort;
  ns.clearPort(portId);

  await log.info("=== RAM-Cache Supervisor Online ===");

  // 1. Load configuration paths from /etc/supervisor.txt
  const config = loadConfig(ns);
  const dataDir = withTrailingSlash(config.dataServerDir);

  // 2. In-memory state database & tracked hostnames index, restored from disk
  const { state: networkState, hostnames: knownHostnames } = loadStateFromDisk(ns, config);
  const state = createSupervisorState(networkState, knownHostnames);

  if (state.networkState.size > 0) {
    await log.info(`[Boot] Restored ${state.networkState.size} servers from disk using index list.`);
  }

  const handlers = createHandlers(log, state);

  // --- SERVE --------------------------------------------------------------
  // Bitburner disallows concurrent NS calls from one script, so the flush
  // timer can't run as its own `while (true) { await ns.sleep(...) }` loop
  // alongside Serve()'s. Instead it piggybacks on Serve()'s own poll loop.

  let lastFlush = Date.now();

  const server = NewServer(ns, portId);
  RegisterSupervisor(server, handlers);

  await log.info(`[Supervisor] Serving Supervisor RPC on Port ${portId}...`);
  await server.Serve(async () => {
    if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
      lastFlush = Date.now();
      await flush(ns, log, config, dataDir, state);
    }
  });
}
