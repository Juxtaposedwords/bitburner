import { NS } from "@ns";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";

const CONFIG_PATH = "/etc/player.txt";

type PlayerConfig = {
  playerInfoPath: string;
  updateIntervalMs: number;
};

const DEFAULT_CONFIG: PlayerConfig = {
  playerInfoPath: "/var/supervisor/playerinfo.txt",
  updateIntervalMs: 5000,
};

function loadConfig(ns: NS): PlayerConfig {
  const rawConfig = ns.read(CONFIG_PATH);
  if (!rawConfig || typeof rawConfig !== "string") {
    ns.write(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "w");
    return DEFAULT_CONFIG;
  }

  try {
    const parsed = JSON.parse(rawConfig) as Partial<PlayerConfig>;
    return {
      playerInfoPath: parsed.playerInfoPath ?? DEFAULT_CONFIG.playerInfoPath,
      updateIntervalMs: parsed.updateIntervalMs ?? DEFAULT_CONFIG.updateIntervalMs,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "PlayerMonitor", LOG_LEVEL.INFO);

  const config = loadConfig(ns);

  log.info(`[PlayerMonitor] Started. Writing player info to ${config.playerInfoPath} every ${config.updateIntervalMs / 1000}s...`);

  while (true) {
    const player = ns.getPlayer();
    ns.write(config.playerInfoPath, JSON.stringify(player, null, 2), "w");
    log.debug(`[PlayerMonitor] Updated player info on disk.`);
    
    await ns.sleep(config.updateIntervalMs);
  }
}