import { Approach } from "system/rpc/scheduler";
import { appendJsonLine } from "system/history";

/**
 * When each run reached each stage, one JSON line per milestone - the
 * record that makes runs comparable. BN12's third run had to be pieced
 * together from gauges whose 24-hour window had already dropped its start.
 * monitoring_daemon.ts appends what it observes each minute;
 * tools/finish_bitnode.ts appends "finish" just before the BitNode ends.
 * build/bridge.mjs archives every line to game/archive/run_milestones.jsonl.
 */
export const MILESTONES_PATH = "/var/run_milestones.txt";
export const MILESTONES_CAP = 500;

export type Milestone = {
  at: number;
  // The run: its BitNode and ns.getResetInfo().lastNodeReset.
  node: number;
  run: number;
  milestone: string;
  // Hours since the run started (wall clock - a closed game counts too).
  hours: number;
  // Set by hand (tools/record_milestone.js): a backfill, a pause...
  note?: string;
};

/** What monitoring_daemon.ts sees in one sample; undefined = not observed. */
export type MilestoneObservation = {
  now: number;
  node: number;
  runStart: number;
  // When system/supervisor.js started (the full system's hub), if running.
  supervisorSince?: number;
  factionDaemon: boolean;
  sleeveGoals: string[];
  inGang: boolean;
  donatable: number;
  phase?: Approach;
};

/** Names already recorded for `run`. */
export function recordedFor(raw: string, run: number): Set<string> {
  const names = new Set<string>();
  for (const line of raw.split("\n")) {
    try {
      const m = JSON.parse(line) as Partial<Milestone>;
      if (m.run === run && m.milestone) names.add(m.milestone);
    } catch {
      // blank or partial line
    }
  }
  return names;
}

export function milestone(node: number, run: number, name: string, at: number, note?: string): Milestone {
  const m: Milestone = { at, node, run, milestone: name, hours: Math.max(0, (at - run) / 3_600_000) };
  if (note) m.note = note;
  return m;
}

/** Milestones `obs` shows that `recorded` doesn't have yet, in order. */
export function dueMilestones(recorded: Set<string>, obs: MilestoneObservation): Milestone[] {
  const due: [string, number][] = [["run_start", obs.runStart]];
  if (obs.supervisorSince !== undefined) due.push(["full_system", Math.max(obs.runStart, obs.supervisorSince)]);
  if (obs.factionDaemon) due.push(["faction_daemon", obs.now]);
  if (obs.sleeveGoals.some((g) => g.startsWith("crime for karma"))) due.push(["sleeves_karma", obs.now]);
  if (obs.inGang) due.push(["gang", obs.now]);
  if (obs.donatable > 0) due.push(["donations", obs.now]);
  if (obs.phase !== undefined && Approach[obs.phase] !== undefined) due.push([`phase_${Approach[obs.phase]}`, obs.now]);
  return due.filter(([name]) => !recorded.has(name)).map(([name, at]) => milestone(obs.node, obs.runStart, name, at));
}

/** `raw` with `entries` appended (newest MILESTONES_CAP kept). */
export function appendMilestones(raw: string, entries: Milestone[]): string {
  return entries.reduce((acc, m) => appendJsonLine(acc, m, MILESTONES_CAP), raw);
}
