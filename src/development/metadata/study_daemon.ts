import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import { Approach, NewSchedulerServiceClient } from "development/metadata/scheduler";
import { decideStudyStep } from "development/metadata/study_decisions";

type CityNameType = Parameters<NS["singularity"]["travelToCity"]>[0];
type UniversityNameType = Parameters<NS["singularity"]["universityCourse"]>[0];
type UniversityClassType = Parameters<NS["singularity"]["universityCourse"]>[1];

/**
 * The player-side half of Approach.GROW_STATS (scheduler.proto): while the
 * scheduler's approach is GROW_STATS, keeps the player in a university class.
 * faction_daemon.ts steps out of the work slot (and holds installs, which
 * would reset hacking experience) for the same approach. Switch with
 * `run tools/set_scheduler_approach.js GROW_STATS` / `... HACK`.
 *
 * Another ns.singularity file, kept separate from faction_daemon.ts and
 * scheduler_daemon.ts for the same RAM-cost reason as the others (see
 * server_metadata.md). Only launched by boot.ts when singularityAvailable.
 */
type StudyConfig = { university: string; course: string };

// The highest-experience university and course. Both cost money per second,
// which gang income covers easily.
const DEFAULT_CONFIG: StudyConfig = { university: "ZB Institute of Technology", course: "Algorithms" };
const CONFIG_PATH = "/etc/study.txt";
const TICK_INTERVAL_MS = 10_000;

async function tick(ns: NS, log: Logger, config: StudyConfig): Promise<void> {
  const res = await NewSchedulerServiceClient(ns).GetSchedulerConfig({});
  const active = res.status === Codes.OK && res.data?.config?.approach === Approach.GROW_STATS;

  const step = decideStudyStep(active, config.university, config.course, ns.getPlayer().city, ns.singularity.getCurrentWork());
  switch (step.kind) {
    case "idle":
    case "studying":
      break;
    case "unknownUniversity":
      await log.warn(`[Study] "${config.university}" isn't a university; check ${CONFIG_PATH}.`);
      break;
    case "travel":
      if (ns.singularity.travelToCity(step.city as CityNameType)) await log.info(`[Study] Traveled to ${step.city}.`);
      else await log.warn(`[Study] Couldn't travel to ${step.city}.`);
      break;
    case "enroll":
      if (ns.singularity.universityCourse(config.university as UniversityNameType, config.course as UniversityClassType)) {
        await log.info(`[Study] Studying ${config.course} at ${config.university}.`);
      } else {
        await log.warn(`[Study] Couldn't start ${config.course} at ${config.university}.`);
      }
      break;
  }

  await log.debug(`[Study] tick: growStats=${active} step=${step.kind} hacking=${ns.getPlayer().skills.hacking}`);
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const log = createLogger(ns, "Study", LOG_LEVEL.DEBUG);
  await log.info("=== Study manager online ===");

  while (true) {
    await tick(ns, log, loadJsonConfig(ns, CONFIG_PATH, DEFAULT_CONFIG));
    await ns.asleep(TICK_INTERVAL_MS);
  }
}
