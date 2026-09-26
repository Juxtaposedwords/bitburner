import { NS } from "@ns";
import { loadJsonConfig } from "development/libraries/config";
import {
  COMBAT_SKILLS,
  compareInstall,
  DAEDALUS_COMBAT_LEVEL,
  effectiveSkillMult,
  hackingGoal,
  PENDING_BOOST_PATH,
  PendingBoost,
} from "development/libraries/skill_progress";
import { parseWindow, readSeries, windowPoints } from "development/libraries/timeseries";
import { CONFIG_PATH as STUDY_CONFIG_PATH, DEFAULT_CONFIG as STUDY_DEFAULTS } from "development/metadata/study_decisions";

/**
 * Both routes to a Daedalus invite (hacking 2500, or 1500 in every combat
 * stat), and whether installing the pending augmentations now gets there
 * sooner:
 *
 *   run tools/skill_eta.js [hacking-target] [--window 1h]
 *
 * Level <-> experience uses the game's own ns.formulas.skills (0 GB, needs
 * Formulas.exe) with each skill's multiplier solved from current level and
 * experience (see skill_progress.ts's effectiveSkillMult). Rates:
 * - hacking: measured experience/min over the window from
 *   monitoring_daemon.ts's gauge/hacking_exp, plus what the configured
 *   class (/etc/study.txt) gives per ns.formulas.work.universityGains;
 * - combat: ns.formulas.work.gymGains at the best gym for each stat, one
 *   stat trained at a time, so the route's time is the sum.
 * ETAs assume those rates hold; the install comparison doesn't need a rate
 * at all (see compareInstall).
 */

type ClassType = Parameters<NS["formulas"]["work"]["universityGains"]>[1];
type LocationNameType = Parameters<NS["formulas"]["work"]["universityGains"]>[2];

const WINDOW_FLAG = "--window";
const DEFAULT_WINDOW_SEC = 3600;
// ns.formulas.work.*Gains are per game cycle, which is 200ms.
const CYCLES_PER_MIN = 300;
const WORLD_DAEMON = "w0r1d_d43m0n";

/** Minutes to go from `exp` to `targetExp` at `expPerMin`; 0 if already there, undefined if the rate isn't positive. */
export function minutesToExp(exp: number, targetExp: number, expPerMin: number): number | undefined {
  if (targetExp <= exp) return 0;
  if (!(expPerMin > 0)) return undefined;
  return (targetExp - exp) / expPerMin;
}

/** "45m", "7.5h", "3.2d", "12.0y", "3.4e+9y"; "never" for undefined. */
export function formatDuration(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return "never";
  if (minutes < 60) return `${Math.ceil(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 365) return `${days.toFixed(1)}d`;
  const years = days / 365;
  return `${years < 1000 ? years.toFixed(1) : years.toExponential(1)}y`;
}

/** Levels to show between current and target: round steps of at least 100, then the target itself. */
export function milestones(current: number, target: number, count = 5): number[] {
  if (target <= current) return [target];
  const step = Math.max(100, Math.ceil((target - current) / count / 100) * 100);
  const levels: number[] = [];
  for (let lvl = Math.ceil((current + 1) / step) * step; lvl < target; lvl += step) levels.push(lvl);
  levels.push(target);
  return levels;
}

function formatExp(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  return Math.abs(n) < 1e4 ? n.toFixed(0) : n.toExponential(2);
}

/** Points after the last drop in value - an install resets experience to 0, and a rate across that drop is meaningless. */
export function sinceLastReset<T extends { v: number }>(points: T[]): T[] {
  for (let i = points.length - 1; i > 0; i--) if (points[i].v < points[i - 1].v) return points.slice(i);
  return points;
}

function measuredExpRate(ns: NS, windowSec: number): { perMin: number; minutes: number } | undefined {
  const series = readSeries(ns, "gauge/hacking_exp");
  if (!series) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const all = windowPoints(series, now, windowSec).filter((p): p is { t: number; v: number } => p.v !== null);
  const points = sinceLastReset(all);
  if (points.length < 2) return undefined;
  const first = points[0];
  const last = points[points.length - 1];
  const minutes = (last.t - first.t) / 60;
  return { perMin: (last.v - first.v) / minutes, minutes };
}

function readPendingBoost(ns: NS): PendingBoost | undefined {
  const raw = ns.read(PENDING_BOOST_PATH);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PendingBoost;
  } catch {
    return undefined;
  }
}

function installVerdict(ratio: number): string {
  if (!Number.isFinite(ratio)) return "goal already reached";
  return ratio < 1 ? `INSTALL NOW - reaches it ${(1 / ratio).toFixed(1)}x sooner` : `keep going - installing is ${ratio.toFixed(1)}x slower`;
}

export async function main(ns: NS): Promise<void> {
  const args = ns.args.map(String);
  let windowSec: number | undefined = DEFAULT_WINDOW_SEC;
  let configuredGoal = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === WINDOW_FLAG) windowSec = parseWindow(args[++i] ?? "");
    else configuredGoal = Number(args[i]);
  }
  if (windowSec === undefined || !(configuredGoal >= 0)) {
    ns.tprint("usage: run tools/skill_eta.js [hacking-target] [--window 1h]");
    return;
  }
  if (!ns.fileExists("Formulas.exe", "home")) {
    ns.tprint("ERROR: needs Formulas.exe for the level <-> experience formulas.");
    return;
  }

  const player = ns.getPlayer();
  const expFor = (level: number, mult: number): number => ns.formulas.skills.calculateExp(level, mult);
  const multFor = (level: number, exp: number): number | undefined =>
    effectiveSkillMult(level, (m) => ns.formulas.skills.calculateSkill(exp, m));

  // From faction_daemon.ts rather than ns.singularity, which would cost ~11 GB.
  const pendingFile = readPendingBoost(ns);
  const boost = pendingFile?.multipliers ?? {};
  const pendingCount = pendingFile?.count ?? 0;
  const lines: string[] = [];
  if (!pendingFile) lines.push(`(no ${PENDING_BOOST_PATH} yet - is faction_daemon.js running? Install comparisons assume nothing pending.)`, "");

  // ---- Hacking route ----
  const goal = hackingGoal(configuredGoal, ns.serverExists(WORLD_DAEMON) ? ns.getServerRequiredHackingLevel(WORLD_DAEMON) : undefined);
  const level = player.skills.hacking;
  const exp = player.exp.hacking;
  const mult = multFor(level, exp);
  const study = loadJsonConfig(ns, STUDY_CONFIG_PATH, STUDY_DEFAULTS);
  const classRate = ns.formulas.work.universityGains(player, study.course as ClassType, study.university as LocationNameType).hackExp * CYCLES_PER_MIN;
  const measured = measuredExpRate(ns, windowSec);
  const rate = measured?.perMin ?? classRate;

  lines.push(`=== Hacking route: level ${goal} ===`);
  if (mult === undefined) {
    lines.push("couldn't solve the hacking multiplier from level and experience");
  } else {
    lines.push(`level ${level}, exp ${formatExp(exp)}, level multiplier x${mult.toFixed(3)}`);
    lines.push(
      `rate: ${measured ? `measured ${formatExp(measured.perMin)}/min over ${Math.round(measured.minutes)}m` : "no measured data yet"}; ` +
        `${study.course} at ${study.university} gives ${formatExp(classRate)}/min by formula` +
        `${measured ? "" : " (used below)"}`
    );
    lines.push(`${"level".padEnd(8)}${"exp needed".padStart(12)}${"eta".padStart(10)}`);
    for (const lvl of milestones(level, goal)) {
      const needed = expFor(lvl, mult);
      lines.push(`${String(lvl).padEnd(8)}${formatExp(needed).padStart(12)}${formatDuration(minutesToExp(exp, needed, rate)).padStart(10)}`);
    }
    const levelBoost = boost.hacking ?? 1;
    const expBoost = boost.hacking_exp ?? 1;
    const c = compareInstall(goal, exp, mult, levelBoost, expBoost, expFor);
    lines.push(
      `install now (${pendingCount} pending: level x${levelBoost.toFixed(3)}, exp x${expBoost.toFixed(3)}): ` +
        `${formatDuration(c.installExp / rate)} from zero vs ${formatDuration(c.stayExp / rate)} staying -> ${installVerdict(c.ratio)}`
    );
  }

  // ---- Combat route ----
  const gyms = Object.values(ns.enums.LocationName).filter((name) => name.endsWith("Gym"));
  lines.push("", `=== Combat route: ${DAEDALUS_COMBAT_LEVEL} in every combat stat ===`);
  lines.push(`${"stat".padEnd(10)}${"level".padStart(6)}${"mult".padStart(8)}${"exp needed".padStart(12)}${"rate/min".padStart(11)}  ${"best gym".padEnd(22)}${"eta".padStart(8)}${"if installed".padStart(14)}`);
  let stayTotal = 0;
  let installTotal = 0;
  for (const stat of COMBAT_SKILLS) {
    const statLevel = player.skills[stat];
    const statExp = player.exp[stat];
    const statMult = multFor(statLevel, statExp);
    const gymType = ns.enums.GymType[stat];
    const expKey = `${gymType}Exp` as "strExp" | "defExp" | "dexExp" | "agiExp";
    let best = { gym: "", perMin: 0 };
    for (const gym of gyms) {
      const perMin = ns.formulas.work.gymGains(player, gymType, gym)[expKey] * CYCLES_PER_MIN;
      if (perMin > best.perMin) best = { gym, perMin };
    }
    if (statMult === undefined) {
      lines.push(`${stat.padEnd(10)}${String(statLevel).padStart(6)}  couldn't solve the multiplier`);
      continue;
    }
    const c = compareInstall(DAEDALUS_COMBAT_LEVEL, statExp, statMult, boost[stat] ?? 1, boost[`${stat}_exp`] ?? 1, expFor);
    const stayMin = best.perMin > 0 ? c.stayExp / best.perMin : Infinity;
    const installMin = best.perMin > 0 ? c.installExp / best.perMin : Infinity;
    stayTotal += stayMin;
    installTotal += installMin;
    lines.push(
      `${stat.padEnd(10)}${String(statLevel).padStart(6)}${("x" + statMult.toFixed(2)).padStart(8)}${formatExp(c.stayExp).padStart(12)}` +
        `${formatExp(best.perMin).padStart(11)}  ${best.gym.padEnd(22)}${formatDuration(stayMin).padStart(8)}${formatDuration(installMin).padStart(14)}`
    );
  }
  lines.push(
    `total, one stat at a time: ${formatDuration(stayTotal)} (${formatDuration(installTotal)} if the ${pendingCount} pending were installed first) -> ` +
      installVerdict(stayTotal > 0 ? installTotal / stayTotal : Infinity)
  );
  lines.push("", "ETAs assume today's rates hold. An install also resets the Hacknet (and its Improve Studying/Gym Training levels).");

  ns.tprintf("%s", lines.join("\n"));
}
