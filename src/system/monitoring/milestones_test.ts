import { describe, expect, it } from "vitest";
import { appendMilestones, dueMilestones, MilestoneObservation, recordedFor } from "system/monitoring/milestones";
import { Approach } from "system/rpc/scheduler";

const HOUR = 3_600_000;
const obs = (over: Partial<MilestoneObservation> = {}): MilestoneObservation => ({
  now: 5 * HOUR,
  node: 12,
  runStart: HOUR,
  factionDaemon: false,
  sleeveGoals: [],
  inGang: false,
  donatable: 0,
  ...over,
});

describe("dueMilestones", () => {
  it("records the run's start at the reset time, and the full system at the supervisor's start", () => {
    const due = dueMilestones(new Set(), obs({ supervisorSince: 1.5 * HOUR }));
    expect(due.map((m) => [m.milestone, m.hours])).toEqual([
      ["run_start", 0],
      ["full_system", 0.5],
    ]);
  });

  it("records each stage once, when first seen", () => {
    const seen = obs({ sleeveGoals: ["faction work: Netburners", "crime for karma: Homicide"], inGang: true, donatable: 1, phase: Approach.AUGMENTS });
    expect(dueMilestones(new Set(), seen).map((m) => m.milestone)).toEqual(["run_start", "sleeves_karma", "gang", "donations", "phase_AUGMENTS"]);
    expect(dueMilestones(new Set(["run_start", "sleeves_karma", "gang", "donations", "phase_AUGMENTS"]), seen)).toEqual([]);
  });
});

describe("recordedFor", () => {
  it("only counts the given run's milestones", () => {
    const raw = appendMilestones("", [...dueMilestones(new Set(), obs({ inGang: true })), ...dueMilestones(new Set(), obs({ runStart: 2 * HOUR }))]);
    expect([...recordedFor(raw, HOUR)]).toEqual(["run_start", "gang"]);
    expect([...recordedFor(raw, 2 * HOUR)]).toEqual(["run_start"]);
  });
});
