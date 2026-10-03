import { NS } from "@ns";
import { readBitNodeInfo } from "development/libraries/bitnode_info";
import { COMBAT_SKILLS, effectiveSkillMult, skillMultiplier } from "development/libraries/skill_progress";
import { installNowEstimate, planTraining, TrainOption } from "development/libraries/training_plan";
import { FACTION_REPS_PATH, FactionRepsFile } from "development/metadata/faction_decisions";
import { CONFIG_PATH as STUDY_CONFIG_PATH, DEFAULT_CONFIG as STUDY_DEFAULT_CONFIG, GYM_CITY, StudyConfig } from "development/metadata/study_decisions";
import { loadJsonConfig } from "development/libraries/config";

type FactionNameType = Parameters<NS["singularity"]["getFactionFavor"]>[0];
type FactionWorkType = Parameters<NS["formulas"]["work"]["factionGains"]>[1];
type UniversityClassType = Parameters<NS["formulas"]["work"]["universityGains"]>[1];
type LocationNameType = Parameters<NS["formulas"]["work"]["universityGains"]>[2];
type Skill = "hacking" | "strength" | "defense" | "dexterity" | "agility" | "charisma";

// ns.formulas.work.*Gains are per 200ms game cycle.
const CYCLES_PER_MIN = 300;
// Rough cost of an install: reboot plus hacking level regrowing from batches.
const INSTALL_OVERHEAD_MINUTES = 10;
const EXP_KEY: Record<Skill, "hackExp" | "strExp" | "defExp" | "dexExp" | "agiExp" | "chaExp"> = {
  hacking: "hackExp",
  strength: "strExp",
  defense: "defExp",
  dexterity: "dexExp",
  agility: "agiExp",
  charisma: "chaExp",
};

/**
 * Would training first reach a faction's rep target sooner than grinding
 * now (development/libraries/training_plan.ts)?
 *
 *   run tools/train_eval.js [faction]
 *
 * Defaults to the faction daemon's work target, else the nearest rep
 * target. Uses the real formulas: rep/min from factionGains for each work
 * type the faction offers (with its favor), exp/min from gymGains (best gym
 * per stat) and universityGains (the study config's university: Algorithms
 * for hacking, Leadership for charisma), and levels from calculateSkill.
 * Report only - nothing is started.
 */
export async function main(ns: NS): Promise<void> {
  if (!ns.fileExists("Formulas.exe", "home")) {
    ns.tprint("Needs Formulas.exe.");
    return;
  }
  const reps = JSON.parse(ns.read(FACTION_REPS_PATH) || "null") as FactionRepsFile | null;
  const targets = reps?.repTargets ?? {};
  const gapOf = (f: string): number => (targets[f] ?? 0) - (reps?.reps[f] ?? 0);
  const nearest = Object.keys(targets).sort((a, b) => gapOf(a) - gapOf(b))[0];
  const faction = (ns.args[0] as string | undefined) ?? reps?.workTarget ?? nearest;
  if (!faction) {
    ns.tprint("No faction given and no rep target to grind - nothing to evaluate.");
    return;
  }
  const gap = gapOf(faction);
  if (!(gap > 0)) {
    ns.tprint(`${faction} has no rep target left (${targets[faction] === undefined ? "none set" : "already reached"}).`);
    return;
  }

  const player = ns.getPlayer();
  const favor = ns.singularity.getFactionFavor(faction as FactionNameType);
  const workTypes = ns.singularity.getFactionWorkTypes(faction as FactionNameType) as FactionWorkType[];
  const bitNodeMultipliers = readBitNodeInfo(ns)?.multipliers;
  const study = loadJsonConfig<StudyConfig>(ns, STUDY_CONFIG_PATH, STUDY_DEFAULT_CONFIG);

  const withLevels = (levels: Record<string, number>): typeof player => ({ ...player, skills: { ...player.skills, ...levels } });
  const repPerMin = (levels: Record<string, number>, type: FactionWorkType): number =>
    ns.formulas.work.factionGains(withLevels(levels), type, favor).reputation * CYCLES_PER_MIN;
  const rateAt = (levels: Record<string, number>): number => Math.max(0, ...workTypes.map((type) => repPerMin(levels, type)));

  const option = (skill: Skill, expPerMin: number, where: string): (TrainOption & { where: string; expPerMin: number }) | undefined => {
    const exp = player.exp[skill];
    const level = player.skills[skill];
    const { mult } = skillMultiplier(skill, player.mults[skill], bitNodeMultipliers, () =>
      effectiveSkillMult(level, (m) => ns.formulas.skills.calculateSkill(exp, m))
    );
    if (mult === undefined || !(expPerMin > 0)) return undefined;
    return { stat: skill, where, expPerMin, levelAfter: (minutes) => ns.formulas.skills.calculateSkill(exp + expPerMin * minutes, mult) };
  };
  const classExp = (course: string, skill: Skill): number =>
    ns.formulas.work.universityGains(player, course as UniversityClassType, study.university as LocationNameType)[EXP_KEY[skill]] * CYCLES_PER_MIN;
  const options = [
    option("hacking", classExp("Algorithms", "hacking"), `${study.university} Algorithms`),
    option("charisma", classExp("Leadership", "charisma"), `${study.university} Leadership`),
    ...COMBAT_SKILLS.map((skill) => {
      const gymType = ns.enums.GymType[skill];
      let best = { gym: "", perMin: 0 };
      for (const gym of Object.keys(GYM_CITY)) {
        const perMin = ns.formulas.work.gymGains(player, gymType, gym as LocationNameType)[EXP_KEY[skill]] * CYCLES_PER_MIN;
        if (perMin > best.perMin) best = { gym, perMin };
      }
      return option(skill, best.perMin, best.gym);
    }),
  ].filter((o): o is NonNullable<typeof o> => o !== undefined);

  const current = Object.fromEntries(options.map((o) => [o.stat, player.skills[o.stat as Skill]]));
  const plan = planTraining(gap, current, rateAt, options);
  const fmt = (m: number): string => (Number.isFinite(m) ? (m >= 120 ? `${(m / 60).toFixed(1)}h` : `${m.toFixed(0)}m`) : "never");

  const out: string[] = [];
  out.push(`=== ${faction}: ${gap.toFixed(0)} rep to go (target ${targets[faction].toFixed(0)}), favor ${favor.toFixed(1)} ===`);
  out.push(`rep/min now: ${workTypes.map((t) => `${t} ${repPerMin({}, t).toFixed(0)}`).join(", ")}`);
  out.push(`skills: ${options.map((o) => `${o.stat} ${player.skills[o.stat as Skill]} (+${o.expPerMin.toExponential(2)} exp/min at ${o.where})`).join("; ")}`);
  out.push(`grind now: ${fmt(plan.grindNowMinutes)}`);
  if (plan.steps.length === 0) {
    out.push("best plan: grind now - no training gets there sooner.");
  } else {
    out.push(`best plan: ${plan.steps.map((s) => `train ${s.stat} ${fmt(s.minutes)} -> ${s.level}`).join(", then ")}, then grind ${fmt(plan.grindMinutes)}`);
    const after = rateAt(Object.fromEntries(plan.steps.map((s) => [s.stat, s.level])));
    out.push(
      `total ${fmt(plan.totalMinutes)} vs ${fmt(plan.grindNowMinutes)} grinding now (saves ${fmt(plan.grindNowMinutes - plan.totalMinutes)}); ` +
        `rep/min after training ${after.toFixed(0)}`
    );
  }
  const install = installNowEstimate(
    reps?.reps[faction] ?? 0,
    favor,
    gap,
    rateAt({}),
    (f) => ns.formulas.reputation.calculateFavorToRep(f),
    (r) => ns.formulas.reputation.calculateRepToFavor(r),
    INSTALL_OVERHEAD_MINUTES
  );
  out.push(
    `install now: favor ${favor.toFixed(1)} -> ${install.favorAfter.toFixed(1)}, rep/min ${rateAt({}).toFixed(0)} -> ${install.rateAfter.toFixed(0)}, ` +
      `rest takes ${fmt(install.afterInstallMinutes)} (incl. ${INSTALL_OVERHEAD_MINUTES}m to recover) vs ${fmt(install.grindNowMinutes)}`
  );
  out.push("(Exp earned while grinding and sleeves' shared exp aren't counted, so the plan leans toward grinding.)");
  ns.tprintf("%s", out.join("\n"));
}
