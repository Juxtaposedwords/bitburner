import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import { createLogger, Logger, LOG_LEVEL } from "development/libraries/logs";
import { Codes } from "development/libraries/status";
import { Approach, NewSchedulerServiceClient } from "development/metadata/scheduler";
import {
  Activity,
  ACTIVITY_PATH,
  ActivityFile,
  chooseTraining,
  CombatNeed,
  CONFIG_PATH,
  decideStudyStep,
  DEFAULT_CONFIG,
  GYM_CITY,
  StudyConfig,
} from "development/metadata/study_decisions";
import { readBitNodeInfo } from "development/libraries/bitnode_info";
import { COMBAT_SKILLS, DAEDALUS_COMBAT_LEVEL, DAEDALUS_HACKING_LEVEL, effectiveSkillMult, skillMultiplier } from "development/libraries/skill_progress";

type CityNameType = Parameters<NS["singularity"]["travelToCity"]>[0];
type UniversityNameType = Parameters<NS["singularity"]["universityCourse"]>[0];
type UniversityClassType = Parameters<NS["singularity"]["universityCourse"]>[1];
type GymLocationNameType = Parameters<NS["singularity"]["gymWorkout"]>[0];
type GymTypeType = Parameters<NS["singularity"]["gymWorkout"]>[1];
type LocationNameType = Parameters<NS["formulas"]["work"]["gymGains"]>[2];

/**
 * The player-side half of Approach.GROW_STATS (scheduler.proto): while the
 * scheduler's approach is GROW_STATS, keeps the player training toward a
 * Daedalus invite - at the gym when 1500 in every combat stat finishes
 * sooner than hacking 2500 (see pickGym), otherwise in a university class.
 * faction_daemon.ts steps out of the work slot for the same approach, buys
 * only hacking augmentations, and installs only when that beats continuing
 * to study (see skill_progress.ts's compareInstall). Switch with
 * `run tools/set_scheduler_approach.js GROW_STATS` / `... HACK`.
 *
 * Another ns.singularity file, kept separate from faction_daemon.ts and
 * scheduler_daemon.ts for the same RAM-cost reason as the others (see
 * server_metadata.md). Only launched by boot.ts when singularityAvailable.
 */
const TICK_INTERVAL_MS = 10_000;

type Skill = "hacking" | (typeof COMBAT_SKILLS)[number];

const CYCLES_PER_MIN = 300; // ns.formulas.work.*Gains are per 200ms game cycle.
const WORLD_DAEMON = "w0r1d_d43m0n";
const DAEDALUS = "Daedalus";

/**
 * The gym workout to do instead of studying, if the combat route to Daedalus
 * finishes sooner (chooseTraining). Everything comes from 0 GB formulas:
 * each skill's multiplier solved from level and experience, experience
 * needed from calculateExp, and the rates from universityGains/gymGains at
 * the best gym per stat. undefined = study. Needs Formulas.exe; without it,
 * always study.
 */
function pickGym(ns: NS, config: StudyConfig): { need: CombatNeed; hackingMinutes: number; combatMinutes: number } | undefined {
  if (!ns.fileExists("Formulas.exe", "home")) return undefined;
  const player = ns.getPlayer();
  const combatRouteOpen = !ns.serverExists(WORLD_DAEMON) && !player.factions.includes(DAEDALUS);
  if (!combatRouteOpen) return undefined;

  const bitNodeMultipliers = readBitNodeInfo(ns)?.multipliers;
  const minutesTo = (skill: Skill, goal: number, perMin: number): number => {
    const level = player.skills[skill];
    const exp = player.exp[skill];
    const { mult } = skillMultiplier(skill, player.mults[skill], bitNodeMultipliers, () =>
      effectiveSkillMult(level, (m) => ns.formulas.skills.calculateSkill(exp, m))
    );
    if (mult === undefined || !(perMin > 0)) return Infinity;
    return Math.max(0, ns.formulas.skills.calculateExp(goal, mult) - exp) / perMin;
  };

  const classPerMin =
    ns.formulas.work.universityGains(player, config.course as UniversityClassType, config.university as LocationNameType).hackExp * CYCLES_PER_MIN;
  const hackingMinutes = minutesTo("hacking", DAEDALUS_HACKING_LEVEL, classPerMin);

  const gyms = Object.keys(GYM_CITY);
  const combat: CombatNeed[] = COMBAT_SKILLS.map((stat) => {
    const gymType = ns.enums.GymType[stat];
    const expKey = `${gymType}Exp` as "strExp" | "defExp" | "dexExp" | "agiExp";
    let best = { gym: gyms[0], perMin: 0 };
    for (const gym of gyms) {
      const perMin = ns.formulas.work.gymGains(player, gymType, gym as LocationNameType)[expKey] * CYCLES_PER_MIN;
      if (perMin > best.perMin) best = { gym, perMin };
    }
    return { stat, gymType, gym: best.gym, minutes: minutesTo(stat, DAEDALUS_COMBAT_LEVEL, best.perMin) };
  });

  const need = chooseTraining(hackingMinutes, combat, combatRouteOpen);
  const combatMinutes = combat.reduce((sum, c) => sum + c.minutes, 0);
  return need ? { need, hackingMinutes, combatMinutes } : undefined;
}

async function tick(ns: NS, log: Logger, config: StudyConfig): Promise<void> {
  const res = await NewSchedulerServiceClient(ns).GetSchedulerConfig({});
  const active = res.status === Codes.OK && res.data?.config?.approach === Approach.GROW_STATS;

  const gym = active ? pickGym(ns, config) : undefined;
  const activity: Activity = gym
    ? { kind: "gym", location: gym.need.gym, detail: gym.need.gymType, stat: gym.need.stat }
    : { kind: "class", location: config.university, detail: config.course };

  const activityFile: ActivityFile = { kind: active ? activity.kind : "none", writtenAt: Date.now() };
  ns.write(ACTIVITY_PATH, JSON.stringify(activityFile), "w");

  const step = decideStudyStep(active, activity, ns.getPlayer().city, ns.singularity.getCurrentWork());
  switch (step.kind) {
    case "idle":
    case "busy":
      break;
    case "unknownLocation":
      await log.warn(`[Study] "${activity.location}" isn't a known ${activity.kind === "class" ? "university" : "gym"}; check ${CONFIG_PATH}.`);
      break;
    case "travel":
      if (ns.singularity.travelToCity(step.city as CityNameType)) await log.info(`[Study] Traveled to ${step.city}.`);
      else await log.warn(`[Study] Couldn't travel to ${step.city}.`);
      break;
    case "start": {
      const started =
        activity.kind === "class"
          ? ns.singularity.universityCourse(activity.location as UniversityNameType, activity.detail as UniversityClassType)
          : ns.singularity.gymWorkout(activity.location as GymLocationNameType, activity.detail as GymTypeType);
      const what = activity.kind === "class" ? `Studying ${activity.detail} at ${activity.location}` : `Training ${activity.stat} at ${activity.location}`;
      const why = gym ? ` (combat route to Daedalus: ~${Math.ceil(gym.combatMinutes)}m vs ~${Math.ceil(gym.hackingMinutes)}m studying)` : "";
      if (started) await log.info(`[Study] ${what}${why}.`);
      else await log.warn(`[Study] Couldn't start: ${what}.`);
      break;
    }
  }

  await log.debug(
    `[Study] tick: growStats=${active} activity=${activity.kind}:${activity.location}/${activity.detail} step=${step.kind} hacking=${ns.getPlayer().skills.hacking}`
  );
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
