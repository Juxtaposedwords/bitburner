import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { applyDefined } from "development/libraries/merge";
import * as rpc from "development/libraries/rpc";
import { Codes } from "development/libraries/status";
import { DispatchSnapshot, ROOTER_MARKER_PATH, scriptsToLaunch } from "development/metadata/dispatch";
import * as player_metadata_pb from "development/metadata/player_metadata";
import * as server_metadata_pb from "development/metadata/server_metadata";

const CONFIG_PATH = "/etc/supervisor.txt";

/** How often dirty records are flushed to disk. Handlers never touch the filesystem. */
const FLUSH_INTERVAL_MS = 1000;

/** How often player state (hacking level, owned port-openers) is refreshed from player.ts's snapshot. */
const PLAYER_CONTEXT_REFRESH_INTERVAL_MS = 10;

/**
 * How often the dispatch check runs. Doesn't need to be tight like the
 * player-context refresh above — player.ts itself only ever writes a new
 * snapshot to disk every 5s, so checking for a change more often than that
 * can't find one any sooner.
 */
const DISPATCH_CHECK_INTERVAL_MS = 5000;

export type SupervisorConfig = {
  serverListPath: string;
  dataServerDir: string;
  playerInfoPath: string;
  // Supervisor's own persisted copy of state.player (distinct from
  // playerInfoPath above, which player.ts owns) - specifically for fields
  // like singularityAvailable that only ever arrive via PatchPlayerMetadata
  // and have no other source to re-derive from on restart.
  playerStatePath: string;
};

// Default configuration if the config file hasn't been created yet
const DEFAULT_CONFIG: SupervisorConfig = {
  serverListPath: "/var/supervisor/server_list.txt",
  dataServerDir: "/var/supervisor/servers/",
  // Written by player.ts; read-only from here.
  playerInfoPath: "/var/supervisor/player.txt",
  playerStatePath: "/var/supervisor/player_state.txt",
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

/**
 * Supervisor's own persisted copy of state.player (see playerStatePath) —
 * restores fields like singularityAvailable across a restart, since
 * they're never re-derived from anywhere else the way hackingLevel/
 * portOpenersOwned are (those get refreshed from player.ts's snapshot
 * within the first PLAYER_CONTEXT_REFRESH_INTERVAL_MS tick regardless).
 */
export function loadPlayerStateFromDisk(ns: NS, config: SupervisorConfig): player_metadata_pb.PlayerMetadata {
  const raw = ns.read(config.playerStatePath);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as player_metadata_pb.PlayerMetadata;
  } catch {
    return {};
  }
}

/**
 * Reads player state out of player.ts's snapshot rather than calling
 * `ns.getHackingLevel()`/`ns.fileExists()` directly — those cost supervisor
 * dedicated RAM allocations for functions it'd only ever use here, whereas
 * `ns.read` is already part of its footprint. Fields come back undefined
 * (leaving the corresponding state untouched) if the snapshot doesn't exist
 * yet or is unreadable. Returns the same generated type PlayerService
 * serves (player_metadata.proto), rather than a second hand-written type
 * shadowing the same fields.
 */
export function readPlayerContext(ns: NS, path: string): player_metadata_pb.PlayerMetadata {
  const raw = ns.read(path);
  if (!raw) return {};
  try {
    const player = JSON.parse(raw) as {
      skills?: {
        hacking?: number;
        strength?: number;
        defense?: number;
        dexterity?: number;
        agility?: number;
        charisma?: number;
        intelligence?: number;
      };
      portOpenersOwned?: number;
    };
    return {
      hackingLevel: player.skills?.hacking,
      portOpenersOwned: player.portOpenersOwned,
      strength: player.skills?.strength,
      defense: player.skills?.defense,
      dexterity: player.skills?.dexterity,
      agility: player.skills?.agility,
      charisma: player.skills?.charisma,
      intelligence: player.skills?.intelligence,
    };
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
  /** Set by PatchPlayerMetadata; tells flush() to persist state.player (see playerStatePath). */
  playerStateDirty: boolean;
  processedSinceFlush: number;
  /**
   * Refreshed every Serve() tick (see main()) so handlers never need `ns`.
   * hackingLevel/portOpenersOwned are the only fields any decision here
   * consumes today (isRootable/isEligible); the rest ride along for
   * PlayerService. Fields are non-optional in practice (createSupervisorState
   * always populates real numbers) even though the generated type marks
   * them optional — see readPlayerContext.
   */
  player: player_metadata_pb.PlayerMetadata;
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
    playerStateDirty: false,
    processedSinceFlush: 0,
    player: {
      hackingLevel,
      portOpenersOwned,
      strength: 1,
      defense: 1,
      dexterity: 1,
      agility: 1,
      charisma: 1,
      intelligence: 0,
    },
  };
}

/** Whether a rooted server has any money on it worth stealing at all — independent of the player's current reach. */
export function hasMoney(server: server_metadata_pb.Metadata): boolean {
  return server.rootStatus === server_metadata_pb.RootStatus.ROOTED && (server.maxMoney ?? 0) > 0;
}

/**
 * Whether a not-yet-rooted server could be nuked right now, given how many
 * port-openers are owned. Independent of hacking level entirely — root
 * access in Bitburner only ever depends on ports, never player skill.
 */
export function isRootable(server: server_metadata_pb.Metadata, portOpenersOwned: number): boolean {
  return (
    server.rootStatus === server_metadata_pb.RootStatus.UNROOTABLE &&
    (server.hacking?.requirements?.ports ?? Infinity) <= portOpenersOwned
  );
}

/**
 * Refines the stored UNROOTABLE/ROOTED base fact (see RootStatus in the
 * proto) against the player's current port-openers every time it's asked
 * for, so ROOTABLE can't go stale the way a value a crawler pushed once
 * and forgot about could.
 */
export function computeRootStatus(server: server_metadata_pb.Metadata, portOpenersOwned: number): server_metadata_pb.RootStatus {
  if (server.rootStatus === server_metadata_pb.RootStatus.ROOTED) return server_metadata_pb.RootStatus.ROOTED;
  return isRootable(server, portOpenersOwned) ? server_metadata_pb.RootStatus.ROOTABLE : server_metadata_pb.RootStatus.UNROOTABLE;
}

/**
 * Whether the player's current hacking level meets a server's requirement.
 * Independent of root status entirely — purely a threshold comparison
 * against a fixed per-server requirement, never stored (there's no action
 * that causes this transition, only the player's hacking XP climbing).
 */
export function computeHackStatus(server: server_metadata_pb.Metadata, hackingLevel: number): server_metadata_pb.HackStatus {
  return (server.hacking?.requirements?.level ?? Infinity) <= hackingLevel
    ? server_metadata_pb.HackStatus.HACKABLE
    : server_metadata_pb.HackStatus.UNHACKABLE;
}

/**
 * Centralizes "is this server currently worth targeting" so callers (e.g.
 * a future target-selection daemon) don't each re-derive the same rule
 * from raw fields: rooted, has money to steal, and within reach of the
 * player's current hacking level.
 */
export function isEligible(server: server_metadata_pb.Metadata, hackingLevel: number): boolean {
  return hasMoney(server) && computeHackStatus(server, hackingLevel) === server_metadata_pb.HackStatus.HACKABLE;
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
      const hackingLevel = state.player.hackingLevel ?? 0;
      const servers = [...state.networkState.values()].map((server) => ({
        ...server,
        rootStatus: computeRootStatus(server, state.player.portOpenersOwned ?? 0),
        hackStatus: computeHackStatus(server, hackingLevel),
      }));
      return {
        servers: req.eligibleOnly ? servers.filter((server) => isEligible(server, hackingLevel)) : servers,
      };
    },
  };
}

/**
 * Serves the same player fields the background task below already
 * refreshes into `state` — so other scripts can get current player context
 * over RPC (free primitives, see server_metadata.md's RAM notes) instead
 * of each paying for their own `ns.getPlayer()` call.
 */
export function createPlayerHandlers(state: SupervisorState): player_metadata_pb.PlayerServiceHandlers {
  return {
    GetPlayerMetadata: (): player_metadata_pb.GetPlayerMetadataResponse => ({ player: state.player }),

    // Lets a one-shot script (e.g. a Source-File/Singularity detector) push
    // a fact into player state once, rather than every future consumer
    // re-deriving it themselves. No key needed, unlike PatchMetadata's
    // hostname - there's only ever one player. Marks playerStateDirty so
    // flush() persists it - otherwise this patch wouldn't survive a
    // supervisor restart, since nothing else re-derives fields like
    // singularityAvailable the way hackingLevel gets refreshed from
    // player.ts's snapshot on every tick regardless.
    PatchPlayerMetadata: (req: player_metadata_pb.PatchPlayerMetadataRequest): player_metadata_pb.PatchPlayerMetadataResponse => {
      if (req.player) {
        applyDefined(state.player, req.player);
        state.playerStateDirty = true;
      }
      return {};
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

  if (state.playerStateDirty) {
    state.playerStateDirty = false;
    ns.write(config.playerStatePath, JSON.stringify(state.player, null, 2), "w");
  }

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
  applyDefined(state.player, loadPlayerStateFromDisk(ns, config));

  if (state.networkState.size > 0) {
    await log.info(`[Boot] Restored ${state.networkState.size} servers from disk using index list.`);
  }

  const handlers = createHandlers(log, state);
  const playerHandlers = createPlayerHandlers(state);

  // --- SERVE --------------------------------------------------------------

  // One RPC server, two services registered onto it: PlayerService rides
  // along on SupervisorServicePort rather than its own auto-assigned port
  // (see player_metadata.proto) — callers must construct
  // NewPlayerServiceClient(ns, SupervisorServicePort) explicitly.
  const server = rpc.NewServer(ns, server_metadata_pb.SupervisorServicePort);
  server_metadata_pb.RegisterSupervisorService(server, handlers);
  player_metadata_pb.RegisterPlayerService(server, playerHandlers);

  server.addBackgroundTask(() => {
    applyDefined(state.player, readPlayerContext(ns, config.playerInfoPath));
  }, PLAYER_CONTEXT_REFRESH_INTERVAL_MS);

  server.addBackgroundTask(async () => {
    await flush(ns, log, config, dataDir, state);
  }, FLUSH_INTERVAL_MS);

  // Dispatches one-shot jobs when the state that gates them changes (see
  // dispatch.ts) — hackingLevel/portOpenersOwned come from the task above,
  // which already refreshes them, so there's nothing new to read there;
  // the rooter's completion marker is the one new (free) read here.
  let lastSnapshot: DispatchSnapshot | undefined;
  server.addBackgroundTask(async () => {
    const snapshot: DispatchSnapshot = {
      hackingLevel: state.player.hackingLevel ?? 0,
      portOpenersOwned: state.player.portOpenersOwned ?? 0,
      rooterMarker: ns.read(ROOTER_MARKER_PATH),
    };
    for (const { script, args } of scriptsToLaunch(lastSnapshot, snapshot)) {
      ns.run(script, 1, ...(args ?? []));
      await log.info(`[Dispatch] Launched ${script}${args ? ` ${args.join(" ")}` : ""}.`);
    }
    lastSnapshot = snapshot;
  }, DISPATCH_CHECK_INTERVAL_MS);

  await log.info(`[Supervisor] Serving Supervisor RPC on Port ${server_metadata_pb.SupervisorServicePort}...`);
  await server.Serve();
}
