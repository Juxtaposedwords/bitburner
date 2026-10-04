import { NS } from "@ns";
import { effectiveReserve, readSavings } from "system/savings";
import { loadJsonConfig } from "system/config";
import { createLogger, LOG_LEVEL } from "system/logs";
import { decideServerInvestment } from "economy/purchased_server_decisions";
import * as player_metadata_pb from "system/rpc/player_metadata";
import * as server_metadata_pb from "system/rpc/server_metadata";

// No proto/RPC for this config - nothing else in the codebase needs to
// query or patch it remotely (same reasoning as hacknet_daemon.ts).
type PurchasedServerConfig = {
  enabled: boolean;
  // Absolute cash floor never spent below.
  reserveMoney: number;
  // Relative throttle: never commit more than this fraction of *current*
  // money in one tick, even before the floor above is reached.
  maxSpendFraction: number;
  // e.g. "pserv" -> "pserv", "pserv-0", "pserv-1", ... (ns.cloud.purchaseServer
  // auto-dedupes on collision anyway - this is a belt-and-suspenders match).
  hostnamePrefix: string;
  // RAM (power of 2) for the very first purchase, before any owned servers
  // exist to size a new purchase off of.
  startingRamGb: number;
};

const DEFAULT_CONFIG: PurchasedServerConfig = {
  enabled: true,
  reserveMoney: 0,
  maxSpendFraction: 0.5,
  hostnamePrefix: "pserv",
  startingRamGb: 8,
};

const CONFIG_PATH = "/etc/purchased_servers.txt";

// Purchases/upgrades are lumpy, infrequent decisions - no need for
// scheduler_daemon.ts's 1000ms batch-check granularity.
const TICK_INTERVAL_MS = 5000;

/** First "${prefix}-${n}" not already present among `owned`'s hostnames. */
function nextHostname(prefix: string, owned: { host: string }[]): string {
  const taken = new Set(owned.map((s) => s.host));
  let n = 0;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // DEBUG so every tick's evaluation is visible, not just successful
  // purchases/upgrades - a "none" decision otherwise looks identical to a
  // hung process from the logs alone (see server_metadata.md).
  const log = createLogger(ns, "PurchasedServer", LOG_LEVEL.DEBUG);

  await log.info("=== Purchased-server manager online ===");

  while (true) {
    const config = loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);

    if (config.enabled) {
      const playerRes = await player_metadata_pb
        .NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)
        .GetPlayerMetadata({});
      const money = playerRes.data?.player?.money ?? 0;

      // Owned servers straight from the game (the supervisor's registry is gone).
      const owned = ns.cloud.getServerNames().map((host) => ({ host, ram: ns.getServerMaxRam(host) }));

      const ramLimit = ns.cloud.getRamLimit();
      const atServerLimit = owned.length >= ns.cloud.getServerLimit();

      const { decision, budget, buyNewCandidate, upgradeCandidate } = decideServerInvestment(
        money,
        // The shared savings target (savings.ts) counts as a reserve too.
        effectiveReserve(config.reserveMoney, readSavings(ns)),
        config.maxSpendFraction,
        ramLimit,
        atServerLimit,
        config.startingRamGb,
        owned,
        (ram) => ns.cloud.getServerCost(ram),
        (host, ram) => ns.cloud.getServerUpgradeCost(host, ram)
      );

      await log.debug(
        `[PurchasedServer] tick: money=$${money.toFixed(0)} budget=$${budget.toFixed(0)} owned=${owned.length}/${ns.cloud.getServerLimit()} ` +
          `buyNew=${buyNewCandidate ? `${buyNewCandidate.ram}GB@$${buyNewCandidate.cost.toFixed(0)}` : "n/a (at server limit)"} ` +
          `upgrade=${upgradeCandidate ? `${upgradeCandidate.host}->${upgradeCandidate.ram}GB@$${upgradeCandidate.cost.toFixed(0)}` : "n/a (none owned or already at ramLimit)"} ` +
          `-> ${decision.kind}`
      );

      if (decision.kind === "buyNew") {
        const host = ns.cloud.purchaseServer(nextHostname(config.hostnamePrefix, owned), decision.ram);
        if (host) await log.info(`[PurchasedServer] Purchased ${host} with ${decision.ram} GB.`);
      } else if (decision.kind === "upgrade") {
        if (ns.cloud.upgradeServer(decision.host, decision.ram)) await log.info(`[PurchasedServer] Upgraded ${decision.host} to ${decision.ram} GB.`);
      }
    }

    await ns.asleep(TICK_INTERVAL_MS);
  }
}
