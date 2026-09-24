import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import * as server_metadata_pb from "development/metadata/server_metadata";

/**
 * The second file (after tools/program_shopper.ts) allowed to import
 * ns.singularity - kept isolated from supervisor.ts/scheduler_daemon.ts/
 * everything else so its RAM cost never leaks into another script's
 * footprint (see server_metadata.md). Only launched by boot.ts when
 * PlayerMetadata.singularityAvailable is true.
 */

const HOME = "home";
const TICK_INTERVAL_MS = 5000;

/**
 * Pure filter, no `ns` dependency - mirrors rooter.ts's selectRootable.
 * A server is worth backdooring once it's rooted, isn't already
 * backdoored, and is a real NPC server (backdoor is meaningless on home
 * and Hacknet/purchased servers can't be backdoored at all). rootStatus
 * alone isn't enough, though: rooting only requires enough open ports to
 * nuke, with no hacking-level check at all - installBackdoor needs the
 * same hacking-skill check as an actual hack (see server_metadata.md's
 * "two independent axes"), which is the separate, always-freshly-computed
 * hackStatus field.
 */
export function selectBackdoorTargets(servers: server_metadata_pb.Metadata[]): server_metadata_pb.Metadata[] {
  return servers.filter(
    (server) =>
      server.rootStatus === server_metadata_pb.RootStatus.ROOTED &&
      server.hackStatus === server_metadata_pb.HackStatus.HACKABLE &&
      server.kind === server_metadata_pb.ServerKind.NPC &&
      !server.backdoorInstalled
  );
}

/**
 * ns.singularity.connect can only hop to a direct neighbor (see
 * NetscriptDefinitions.d.ts) - walks pathFromHome ("home -> a -> b") hop by
 * hop rather than jumping straight to the target, then returns to home so
 * the terminal doesn't end up parked somewhere unexpected for the player's
 * own manual use. Returns false (leaving the target for the next pass)
 * if any hop fails, e.g. a stale pathFromHome from a network change.
 */
async function backdoor(ns: NS, pathFromHome: string): Promise<boolean> {
  const hops = pathFromHome.split(" -> ").filter((hop) => hop !== HOME);
  for (const hop of hops) {
    if (!ns.singularity.connect(hop)) return false;
  }

  await ns.singularity.installBackdoor();
  ns.singularity.connect(HOME);
  return true;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Backdoor", LOG_LEVEL.INFO);

  await log.info("=== Backdoor manager online ===");

  const client = server_metadata_pb.NewSupervisorServiceClient(ns);

  while (true) {
    const res = await client.ListServers({});
    if (res.status !== Codes.OK) {
      await log.warn(`[Backdoor] ListServers failed (${Codes[res.status]}): ${res.error}`);
      await ns.asleep(TICK_INTERVAL_MS);
      continue;
    }

    const targets = selectBackdoorTargets(res.data?.servers ?? []);

    for (const server of targets) {
      if (!server.hostname || !server.pathFromHome) continue;

      await log.info(`[Backdoor] Backdooring ${server.hostname}...`);
      const ok = await backdoor(ns, server.pathFromHome);
      if (!ok) {
        await log.warn(`[Backdoor] Failed to connect to ${server.hostname}; leaving it for the next pass.`);
        continue;
      }

      const patched = await client.PatchMetadata({ server: { hostname: server.hostname, backdoorInstalled: true } });
      if (patched.status !== Codes.OK) {
        await log.error(
          `[Backdoor] Backdoored ${server.hostname} but failed to update its status (${Codes[patched.status]}): ${patched.error}`
        );
        continue;
      }

      await log.info(`[Backdoor] Backdoored ${server.hostname}.`);
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
