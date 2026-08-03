import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, LOG_LEVEL } from "development/libraries/logs";

const CONFIG_PATH = "/etc/player.txt";

const PORT_OPENER_PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];

type PlayerConfig = {
  playerInfoPath: string;
  updateIntervalMs: number;
};

const DEFAULT_CONFIG: PlayerConfig = {
  playerInfoPath: "/var/supervisor/player.txt",
  updateIntervalMs: 5000,
};

function loadConfig(ns: NS): PlayerConfig {
  return loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "PlayerMonitor", LOG_LEVEL.INFO);

  const config = loadConfig(ns);

  await log.info(
    `[PlayerMonitor] Started. Writing player info to ${config.playerInfoPath} every ${config.updateIntervalMs / 1000}s...`
  );

  while (true) {
    const player = ns.getPlayer();
    const portOpenersOwned = PORT_OPENER_PROGRAMS.filter((program) => ns.fileExists(program, "home")).length;
    ns.write(config.playerInfoPath, JSON.stringify({ ...player, portOpenersOwned }, null, 2), "w");
    await log.debug(`[PlayerMonitor] Updated player info on disk.`);

    await ns.asleep(config.updateIntervalMs);
  }
}
