import { describe, expect, it } from "vitest";
import { addRepSample, installNowEstimate, measuredRepPerMin, planTraining, TrainOption } from "factions/training_plan";

// Rep/min linear in hacking; levels grow with the square root of training time.
const rateAt = (levels: Record<string, number>): number => levels.hacking;
const hacking = (start: number, perSqrtMin: number): TrainOption => ({
  stat: "hacking",
  levelAfter: (minutes) => Math.floor(start + perSqrtMin * Math.sqrt(minutes)),
});

describe("planTraining", () => {
  it("grinds now when training can't pay off", () => {
    const plan = planTraining(1000, { hacking: 100 }, rateAt, [hacking(100, 1)]);
    expect(plan.steps).toEqual([]);
    expect(plan.totalMinutes).toBe(10);
    expect(plan.grindNowMinutes).toBe(10);
  });

  it("trains first when that reaches the target sooner", () => {
    const plan = planTraining(1e6, { hacking: 100 }, rateAt, [hacking(100, 100)]);
    expect(plan.grindNowMinutes).toBe(10000);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].stat).toBe("hacking");
    expect(plan.totalMinutes).toBeLessThan(plan.grindNowMinutes / 2);
    expect(plan.totalMinutes).toBe(plan.trainMinutes + plan.grindMinutes);
  });

  it("stops training once another chunk saves less than it costs", () => {
    const plan = planTraining(1e6, { hacking: 100 }, rateAt, [hacking(100, 100)]);
    const oneMore = 5 + 1e6 / Math.floor(100 + 100 * Math.sqrt(plan.trainMinutes + 5));
    expect(oneMore).toBeGreaterThanOrEqual(plan.grindMinutes);
  });

  it("looks past chunks that don't reach a whole level yet", () => {
    // No level until 20 minutes, then a big jump.
    const stepwise: TrainOption = { stat: "hacking", levelAfter: (m) => (m >= 20 ? 1000 : 100) };
    const plan = planTraining(1e5, { hacking: 100 }, rateAt, [stepwise]);
    expect(plan.steps).toEqual([{ stat: "hacking", minutes: 20, level: 1000 }]);
    expect(plan.totalMinutes).toBe(120);
  });

  it("picks whichever stat the work's rate responds to", () => {
    const fieldRate = (levels: Record<string, number>): number => levels.strength + levels.hacking / 10;
    const options: TrainOption[] = [
      { stat: "hacking", levelAfter: (m) => 100 + 10 * m },
      { stat: "strength", levelAfter: (m) => 100 + 10 * m },
    ];
    const plan = planTraining(1e6, { hacking: 100, strength: 100 }, fieldRate, options);
    expect(plan.steps.every((s) => s.stat === "strength")).toBe(true);
  });

  it("respects maxMinutes", () => {
    const plan = planTraining(1e9, { hacking: 100 }, rateAt, [hacking(100, 1000)], 5, 30);
    expect(plan.trainMinutes).toBeLessThanOrEqual(30);
  });
});

describe("installNowEstimate", () => {
  // Bitburner's favor curve: rep = 25000 * (1.02^favor - 1).
  const favorToRep = (f: number): number => 25000 * (Math.pow(1.02, f) - 1);
  const repToFavor = (r: number): number => Math.log(r / 25000 + 1) / Math.log(1.02);

  it("banks this run's rep as favor and speeds up the rest (BN10 BitRunners)", () => {
    const e = installNowEstimate(105846, 0, 356644, 990, favorToRep, repToFavor, 10);
    expect(e.favorAfter).toBeCloseTo(83.6, 0);
    expect(e.rateAfter).toBeCloseTo(990 * 1.836, -1);
    expect(e.grindNowMinutes / 60).toBeCloseTo(6.0, 1);
    expect(e.afterInstallMinutes / 60).toBeCloseTo(3.4, 1);
  });

  it("gains nothing with no rep earned this run", () => {
    const e = installNowEstimate(0, 50, 1000, 100, favorToRep, repToFavor, 10);
    expect(e.favorAfter).toBeCloseTo(50, 5);
    expect(e.afterInstallMinutes).toBeCloseTo(20, 5);
  });
});

describe("rep rate samples", () => {
  it("measures rep/min over the window", () => {
    let samples = addRepSample([], { t: 0, rep: 1000 }, 600_000);
    samples = addRepSample(samples, { t: 60_000, rep: 1500 }, 600_000);
    samples = addRepSample(samples, { t: 120_000, rep: 2000 }, 600_000);
    expect(measuredRepPerMin(samples, 60_000)).toBe(500);
  });

  it("drops samples older than the window", () => {
    let samples = addRepSample([], { t: 0, rep: 0 }, 60_000);
    samples = addRepSample(samples, { t: 100_000, rep: 100 }, 60_000);
    expect(samples).toEqual([{ t: 100_000, rep: 100 }]);
  });

  it("starts over when rep drops (an install)", () => {
    let samples = addRepSample([], { t: 0, rep: 5000 }, 600_000);
    samples = addRepSample(samples, { t: 60_000, rep: 10 }, 600_000);
    expect(samples).toEqual([{ t: 60_000, rep: 10 }]);
    expect(measuredRepPerMin(samples, 60_000)).toBeUndefined();
  });

  it("needs minSpanMs of data", () => {
    const samples = [{ t: 0, rep: 0 }, { t: 30_000, rep: 100 }];
    expect(measuredRepPerMin(samples, 60_000)).toBeUndefined();
  });
});
