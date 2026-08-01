import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import * as rpc from "development/libraries/rpc";
import { Codes } from "development/libraries/status";
import * as server_metadata_pb from "development/metadata/server_metadata";

const CONFIG_PATH = "/etc/supervisor.txt";

/** How often dirty records are flushed to disk. Handlers never touch the filesystem. */
const FLUSH_INTERVAL_MS = 1000;

/** How often player state (hacking level, owned port-openers) is refreshed from player.ts's snapshot. */
const PLAYER_CONTEXT_REFRESH_INTERVAL_MS = 10;

export type SupervisorConfig = {
  serverListPath: string;
  dataServerDir: string;
  playerInfoPath: string;
};

// Default configuration if the config file hasn't been created yet
const DEFAULT_CONFIG: SupervisorConfig = {
  serverListPath: "/var/supervisor/server_list.txt",
  dataServerDir: "/var/supervisor/servers/",
  // Written by player.ts; read-only from here.
  playerInfoPath: "/var/supervisor/player.txt",
};

export const withTrailingSlash = (dir: string): string => (dir.endsWith("/") ? dir : `${dir}/`);

export function loadConfig(ns: NS): SupervisorConfig {
  return loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
}

export function loadStateFromDisk(
  ns: NS,
  config: SupervisorConfig
): { state: Map<string, server_metadata_pb.Metadata>; hostnames: Set<string> } {
  const state = new Map<string, server_metadata_pb.Metadata>();
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
        const server = JSON.parse(rawData) as server_metadata_pb.Metadata;
        if (server?.hostname) state.set(server.hostname, server);
      } catch {
        // Ignore corrupted files
      }
    }
  }

  return { state, hostnames };
}

export type PlayerContext = { hackingLevel?: number; portOpenersOwned?: number };

/**
 * Reads player state out of player.ts's snapshot rather than calling
 * `ns.getHackingLevel()`/`ns.fileExists()` directly — those cost supervisor
 * dedicated RAM allocations for functions it'd only ever use here, whereas
 * `ns.read` is already part of its footprint. Fields come back undefined
 * (leaving the corresponding state untouched) if the snapshot doesn't exist
 * yet or is unreadable.
 */
export function readPlayerContext(ns: NS, path: string): PlayerContext {
  const raw = ns.read(path);
  if (!raw) return {};
  try {
    const player = JSON.parse(raw) as { skills?: { hacking?: number }; portOpenersOwned?: number };
    return { hackingLevel: player.skills?.hacking, portOpenersOwned: player.portOpenersOwned };
  } catch {
    return {};
  }
}

/**
 * Shallow merge that ignores explicitly-undefined fields.
 *
 * Proto3 `optional` fields arrive as `undefined` when unset, so a plain
 * `{ ...existing, ...patch }` would clobber good values with undefined.
 */
export function mergeDefined(base: server_metadata_pb.Metadata, patch: server_metadata_pb.Metadata): server_metadata_pb.Metadata {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as server_metadata_pb.Metadata;
}

/** All of the supervisor's RAM-resident, mutable state. */
export type SupervisorState = {
  networkState: Map<string, server_metadata_pb.Metadata>;
  knownHostnames: Set<string>;
  pendingWrites: Map<string, server_metadata_pb.Metadata>;
  listDirty: boolean;
  processedSinceFlush: number;
  /** Refreshed every Serve() tick (see main()) so handlers never need `ns`. */
  hackingLevel: number;
  /** Refreshed every Serve() tick alongside hackingLevel; see readPlayerContext. */
  portOpenersOwned: number;
};

export function createSupervisorState(
  networkState: Map<string, server_metadata_pb.Metadata> = new Map(),
  knownHostnames: Set<string> = new Set(),
  hackingLevel = 1,
  portOpenersOwned = 0
): SupervisorState {
  return {
    networkState,
    knownHostnames,
    pendingWrites: new Map(),
    listDirty: false,
    processedSinceFlush: 0,
    hackingLevel,
    portOpenersOwned,
  };
}

/**
 * Centralizes "is this server currently worth targeting" so callers (e.g. a
 * future target-selection daemon) don't each re-derive the same rule from
 * raw fields: rooted, has money to steal, and within reach of the player's
 * current hacking level.
 */
export function isEligible(server: server_metadata_pb.Metadata, hackingLevel: number): boolean {
  return !!server.hacked && (server.maxMoney ?? 0) > 0 && (server.hacking?.requirements?.level ?? Infinity) <= hackingLevel;
}

/** Whether a not-yet-rooted server could be nuked right now, given how many port-openers are owned. */
export function isRootable(server: server_metadata_pb.Metadata, portOpenersOwned: number): boolean {
  return !server.hacked && (server.hacking?.requirements?.ports ?? Infinity) <= portOpenersOwned;
}

/**
 * The single lifecycle stage a server is in right now. Computed fresh from
 * centrally-tracked player state every time it's asked for — never stored on
 * the record itself, so it can't go stale the way a value a crawler pushed
 * once and forgot about could.
 */
export function computeStatus(
  server: server_metadata_pb.Metadata,
  hackingLevel: number,
  portOpenersOwned: number
): server_metadata_pb.ServerStatus {
  if (server.hacked) {
    return isEligible(server, hackingLevel) ? server_metadata_pb.ServerStatus.ELIGIBLE : server_metadata_pb.ServerStatus.ROOTED;
  }
  return isRootable(server, portOpenersOwned) ? server_metadata_pb.ServerStatus.ROOTABLE : server_metadata_pb.ServerStatus.DISCOVERED;
}

/**
 * Builds the RPC handlers. These stay synchronous and RAM-only so the
 * caller's round trip is cheap — durability is `flush`'s job, not theirs.
 */
export function createHandlers(log: Logger, state: SupervisorState): server_metadata_pb.SupervisorServiceHandlers {
  return {
    UpdateMetadata: (req: server_metadata_pb.UpdateMetadataRequest): server_metadata_pb.UpdateMetadataResponse => {
      const server = req.server;
      if (!server?.hostname) {
        throw new rpc.RpcError(Codes.INVALID_ARGUMENT, "UpdateMetadata: request.server.hostname is required");
      }

      state.networkState.set(server.hostname, server);
      state.pendingWrites.set(server.hostname, server);

      if (!state.knownHostnames.has(server.hostname)) {
        state.knownHostnames.add(server.hostname);
        state.listDirty = true;
      }

      state.processedSinceFlush++;
      return {};
    },

    PatchMetadata: async (req: server_metadata_pb.PatchMetadataRequest): Promise<server_metadata_pb.PatchMetadataResponse> => {
      const patch = req.server;
      if (!patch?.hostname) {
        throw new rpc.RpcError(Codes.INVALID_ARGUMENT, "PatchMetadata: request.server.hostname is required");
      }

      const existing = state.networkState.get(patch.hostname);
      if (!existing) {
        await log.warn(`[Patch] Ignored patch for unknown server: ${patch.hostname}`);
        throw new rpc.RpcError(Codes.NOT_FOUND, `PatchMetadata: unknown hostname '${patch.hostname}'`);
      }

      const updated = mergeDefined(existing, patch);
      state.networkState.set(patch.hostname, updated);
      state.pendingWrites.set(patch.hostname, updated);

      state.processedSinceFlush++;
      return {};
    },

    ListServers: (req: server_metadata_pb.ListServersRequest): server_metadata_pb.ListServersResponse => {
      const servers = [...state.networkState.values()].map((server) => ({
        ...server,
        status: computeStatus(server, state.hackingLevel, state.portOpenersOwned),
      }));
      return {
        servers: req.eligibleOnly ? servers.filter((server) => server.status === server_metadata_pb.ServerStatus.ELIGIBLE) : servers,
      };
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
  // Every read/reset of `state` happens in this stretch, with no `await`
  // anywhere in it. Single-threaded JS guarantees nothing else — no
  // concurrently-running handler, no other background task — can run
  // partway through a synchronous stretch, so this is a true atomic
  // snapshot-and-reset of everything that changed since the last flush. No
  // lock required: the race only existed because the old version awaited a
  // log call in between touching different fields, handing control back to
  // the event loop mid-operation. Once nothing here yields, there's no gap
  // for anything else to land in.
  if (state.pendingWrites.size > 0) {
    for (const server of state.pendingWrites.values()) {
      ns.write(`${dataDir}${server.hostname}.txt`, JSON.stringify(server, null, 2), "w");
    }
    state.pendingWrites.clear();
  }

  const wasListDirty = state.listDirty;
  if (wasListDirty) {
    state.listDirty = false;
    ns.write(config.serverListPath, JSON.stringify([...state.knownHostnames], null, 2), "w");
  }
  const knownHostnameCount = state.knownHostnames.size;

  const processedCount = state.processedSinceFlush;
  state.processedSinceFlush = 0;
  const networkSize = state.networkState.size;

  // --- end of synchronous critical section: only awaits below, and only
  // on values already captured above, never on live `state` again ---

  if (wasListDirty) {
    await log.debug(`[Disk] Updated master server list index (${knownHostnameCount} total servers).`);
  }

  if (processedCount > 0) {
    await log.info(`[Sync] Processed ${processedCount} updates into RAM. Total nodes tracked: ${networkSize}`);
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Supervisor", LOG_LEVEL.INFO);

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

  const server = rpc.NewServer(ns, server_metadata_pb.SupervisorServicePort);
  server_metadata_pb.RegisterSupervisorService(server, handlers);

  server.addBackgroundTask(() => {
    const playerContext = readPlayerContext(ns, config.playerInfoPath);
    if (playerContext.hackingLevel !== undefined) state.hackingLevel = playerContext.hackingLevel;
    if (playerContext.portOpenersOwned !== undefined) state.portOpenersOwned = playerContext.portOpenersOwned;
  }, PLAYER_CONTEXT_REFRESH_INTERVAL_MS);

  server.addBackgroundTask(async () => {
    await flush(ns, log, config, dataDir, state);
  }, FLUSH_INTERVAL_MS);

  await log.info(`[Supervisor] Serving Supervisor RPC on Port ${server_metadata_pb.SupervisorServicePort}...`);
  await server.Serve();
}
