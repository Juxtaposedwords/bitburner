import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import * as rpc from "development/libraries/rpc";
import * as server_metadata_pb from "development/metadata/server_metadata";

const CONFIG_PATH = "/etc/target_selector.txt";

export type TargetSelectorConfig = { weightsPath: string };

// Not supervisor's own data (it neither reads nor writes this), so it lives
// under its own directory rather than alongside supervisor's files.
const DEFAULT_CONFIG: TargetSelectorConfig = {
  weightsPath: "/var/target_selector/weights.txt",
};

export function loadConfig(ns: NS): TargetSelectorConfig {
  return loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
}

export type WeightedServer = { hostname: string; weight: number };

export type WeightsFile = {
  hackingLevel: number;
  computedAt: number;
  weights: WeightedServer[];
};

/**
 * $/sec proxy: more money and lower security both make a target more
 * attractive. Placeholder heuristic, swappable once real HWGW timing math
 * exists to compute actual $/sec.
 */
export function weightOf(server: server_metadata_pb.Metadata): number {
  return (server.maxMoney ?? 0) / Math.max(server.minSecurityLevel ?? 1, 1);
}

export function computeWeights(servers: server_metadata_pb.Metadata[]): WeightedServer[] {
  return servers
    .filter((server): server is server_metadata_pb.Metadata & { hostname: string } => !!server.hostname)
    .map((server) => ({ hostname: server.hostname, weight: weightOf(server) }))
    .sort((a, b) => b.weight - a.weight);
}

/** Hacking level is the only thing that currently invalidates weights (see supervisor.ts's isEligible). */
export function shouldRecompute(storedHackingLevel: number | undefined, currentHackingLevel: number): boolean {
  return storedHackingLevel !== currentHackingLevel;
}

export function readWeightsFile(ns: NS, path: string): WeightsFile | undefined {
  const raw = ns.read(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as WeightsFile;
  } catch {
    return undefined;
  }
}

/**
 * A one-time job, not a daemon: computes weights once and exits. Triggered
 * on demand by player.ts when it sees the hacking level change, and once at
 * boot (see boot.ts) so a restart is never left without any weights at all.
 * Re-running it when nothing's actually changed is a cheap no-op — that's
 * the point of stamping the file with the hacking level it was computed at.
 */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "TargetSelector", LOG_LEVEL.INFO);

  const config = loadConfig(ns);

  const hackingLevel = ns.getHackingLevel();
  const existing = readWeightsFile(ns, config.weightsPath);

  if (!shouldRecompute(existing?.hackingLevel, hackingLevel)) {
    await log.info(`[Weights] Already up to date for hacking level ${hackingLevel}.`);
    return;
  }

  const res = await server_metadata_pb.NewSupervisorServiceClient(ns).ListServers({ eligibleOnly: true });
  if (res.status !== rpc.Codes.OK) {
    await log.warn(`[Weights] ListServers failed (${rpc.Codes[res.status]}): ${res.error}`);
    return;
  }

  const weights = computeWeights(res.data?.servers ?? []);

  const file: WeightsFile = { hackingLevel, computedAt: Date.now(), weights };
  ns.write(config.weightsPath, JSON.stringify(file, null, 2), "w");

  await log.info(`[Weights] Recomputed for hacking level ${hackingLevel}. Top target: ${weights[0]?.hostname ?? "none"}.`);
}
