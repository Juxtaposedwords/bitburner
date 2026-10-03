/**
 * Pure logic: would training first reach a faction's rep target sooner than
 * grinding now? No `ns` - the game formulas come in as functions (see
 * tools/train_eval.ts for the real ones).
 *
 * Faction work rep is linear in the stats it uses (hacking contracts:
 * hacking; security: hacking + combat; field: those + charisma), while each
 * level costs exponentially more exp - so a little training can pay off a
 * lot early, and stops paying quickly. Nothing is earned while training.
 *
 * Planned greedily in chunks of `stepMinutes`: each round tries training
 * each stat for 1..`lookaheadSteps` more chunks (levels floor to whole
 * numbers, so a single chunk can show no gain even when more would) and
 * takes the choice that cuts total time the most. Stops once no choice
 * saves time, or at `maxMinutes` of training.
 */

/** A stat that can be trained: its level after `minutes` more of training (from now). */
export type TrainOption = { stat: string; levelAfter: (minutes: number) => number };

export type TrainingStep = { stat: string; minutes: number; level: number };

export type TrainingPlan = {
  grindNowMinutes: number;
  steps: TrainingStep[];
  trainMinutes: number;
  grindMinutes: number;
  totalMinutes: number;
};

export function planTraining(
  gap: number,
  current: Record<string, number>,
  rateAt: (levels: Record<string, number>) => number,
  options: TrainOption[],
  stepMinutes = 5,
  maxMinutes = 600,
  lookaheadSteps = 6
): TrainingPlan {
  const grindAt = (levels: Record<string, number>): number => {
    const rate = rateAt(levels);
    return rate > 0 ? gap / rate : Infinity;
  };
  const grindNowMinutes = grindAt(current);

  const trained: Record<string, number> = {};
  const levelsWith = (extra: Record<string, number>): Record<string, number> => {
    const levels = { ...current };
    for (const option of options) {
      const minutes = (trained[option.stat] ?? 0) + (extra[option.stat] ?? 0);
      if (minutes > 0) levels[option.stat] = option.levelAfter(minutes);
    }
    return levels;
  };

  const steps: TrainingStep[] = [];
  let trainMinutes = 0;
  let grindMinutes = grindNowMinutes;
  while (trainMinutes < maxMinutes) {
    let best: { stat: string; minutes: number; grind: number; saving: number } | undefined;
    for (const option of options) {
      for (let k = 1; k <= lookaheadSteps && trainMinutes + k * stepMinutes <= maxMinutes; k++) {
        const minutes = k * stepMinutes;
        const grind = grindAt(levelsWith({ [option.stat]: minutes }));
        const saving = grindMinutes - (minutes + grind);
        if (saving > 0 && (!best || saving > best.saving)) best = { stat: option.stat, minutes, grind, saving };
      }
    }
    if (!best) break;
    trained[best.stat] = (trained[best.stat] ?? 0) + best.minutes;
    trainMinutes += best.minutes;
    grindMinutes = best.grind;
    const level = levelsWith({})[best.stat];
    const last = steps[steps.length - 1];
    if (last && last.stat === best.stat) {
      last.minutes += best.minutes;
      last.level = level;
    } else {
      steps.push({ stat: best.stat, minutes: best.minutes, level });
    }
  }

  return { grindNowMinutes, steps, trainMinutes, grindMinutes, totalMinutes: trainMinutes + grindMinutes };
}

export type InstallEstimate = { favorAfter: number; rateAfter: number; grindNowMinutes: number; afterInstallMinutes: number };

/**
 * What installing now would do for a faction's grind. Favor comes from all
 * rep ever earned there (favorToRep(favor) + this run's rep), and rep gain
 * is multiplied by 1 + favor/100 - so an install banks this run's rep as
 * favor and speeds up the rest, while the rep still needed for the favor
 * target stays the same. `overheadMinutes` covers the reboot and the stats
 * regrowing afterwards. `favorToRep`/`repToFavor` are
 * ns.formulas.reputation.calculateFavorToRep/calculateRepToFavor.
 */
export function installNowEstimate(
  runRep: number,
  favor: number,
  gap: number,
  ratePerMin: number,
  favorToRep: (favor: number) => number,
  repToFavor: (rep: number) => number,
  overheadMinutes: number
): InstallEstimate {
  const favorAfter = repToFavor(favorToRep(favor) + runRep);
  const rateAfter = (ratePerMin / (1 + favor / 100)) * (1 + favorAfter / 100);
  return {
    favorAfter,
    rateAfter,
    grindNowMinutes: ratePerMin > 0 ? gap / ratePerMin : Infinity,
    afterInstallMinutes: rateAfter > 0 ? overheadMinutes + gap / rateAfter : Infinity,
  };
}

export type RepSample = { t: number; rep: number };

/**
 * Adds a sample of a faction's rep and keeps the last `windowMs`. A drop in
 * rep (an install reset it, or the target changed) starts over.
 */
export function addRepSample(samples: RepSample[], sample: RepSample, windowMs: number): RepSample[] {
  const last = samples[samples.length - 1];
  const kept = last && sample.rep < last.rep ? [] : samples.filter((s) => sample.t - s.t <= windowMs);
  return [...kept, sample];
}

/** Rep/min measured across the samples - the player, sleeves and share together - or undefined with under `minSpanMs` of data. */
export function measuredRepPerMin(samples: RepSample[], minSpanMs: number): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.t - first.t;
  return span >= minSpanMs ? ((last.rep - first.rep) / span) * 60_000 : undefined;
}
