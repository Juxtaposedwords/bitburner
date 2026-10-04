import { NS } from "@ns";

/**
 * Minimal fixed-step time series, one small JSON file per series under
 * /var/monitoring/ - timestamps are implied by position (start + i * step),
 * so each point costs a single number. Retention is a hard cap: appending
 * past `capacity` drops the oldest point. That cap matters because files on
 * home are stored in the save file - an append-forever log would bloat it
 * indefinitely.
 *
 * Times are unix seconds. The pure functions below have no `ns`
 * dependency; only readSeries/writeSeries/listSeries touch the game.
 */
export type Series = { start: number; step: number; values: (number | null)[] };
export type Point = { t: number; v: number | null };

export const MONITORING_DIR = "/var/monitoring/";
export const DEFAULT_STEP_SECONDS = 60;
// 24h at one point per minute.
export const DEFAULT_CAPACITY = 1440;

/**
 * Returns a new series with `value` recorded at time `t`. `t` maps to a slot
 * by rounding (t - start) / step, so small timer jitter lands in the right
 * slot. A slot past the end fills the gap with nulls - a sampler that was
 * down shows up as a gap, never as invented data. The current last slot (or
 * an earlier one, if the clock went backwards) overwrites the last value. A
 * gap longer than the whole capacity, or a step change, starts over.
 */
export function appendPoint(series: Series | undefined, t: number, value: number, step: number, capacity: number): Series {
  if (!series || series.step !== step || series.values.length === 0) {
    return { start: t, step, values: [value] };
  }

  const last = series.values.length - 1;
  const slot = Math.round((t - series.start) / step);

  let values: (number | null)[];
  if (slot <= last) {
    values = [...series.values.slice(0, last), value];
  } else {
    const gap = slot - last - 1;
    if (gap >= capacity) return { start: t, step, values: [value] };
    values = [...series.values, ...new Array<null>(gap).fill(null), value];
  }

  const drop = Math.max(0, values.length - capacity);
  return { start: series.start + drop * step, step, values: values.slice(drop) };
}

/** Every point (including null gaps) whose time falls in [now - windowSec, now]. */
export function windowPoints(series: Series, now: number, windowSec: number): Point[] {
  const from = now - windowSec;
  return series.values
    .map((v, i) => ({ t: series.start + i * series.step, v }))
    .filter((p) => p.t >= from && p.t <= now);
}

/**
 * Average per-minute change over the window, between its first and last
 * non-null points: positive for a rising series; undefined with fewer than
 * two points.
 */
export function averageRatePerMin(series: Series, now: number, windowSec: number): number | undefined {
  const points = windowPoints(series, now, windowSec).filter((p): p is { t: number; v: number } => p.v !== null);
  if (points.length < 2) return undefined;
  const first = points[0];
  const last = points[points.length - 1];
  return (last.v - first.v) / ((last.t - first.t) / 60);
}

/**
 * Signed per-minute rate of a cumulative counter, one entry per point after
 * the first non-null one. Each rate is measured against the previous
 * non-null point, so a gap spreads its change over the gap's duration
 * instead of spiking; a null point yields a null rate.
 *
 * Negative rates are real, not resets: getMoneySources() records spending
 * as negative amounts (augmentations, hacknet_expenses, ... accumulate
 * downward), and a category like stock can go down on realized losses. An
 * earlier version treated any negative delta as a reset and nulled it,
 * which silently blanked every spend series. With sinceStart counters the
 * only true reset is a new BitNode, which shows up as a single spike.
 */
export function counterRates(points: Point[]): { t: number; perMin: number | null }[] {
  const rates: { t: number; perMin: number | null }[] = [];
  let prev: { t: number; v: number } | undefined;

  for (const p of points) {
    if (p.v === null) {
      if (prev) rates.push({ t: p.t, perMin: null });
      continue;
    }
    if (prev && p.t > prev.t) rates.push({ t: p.t, perMin: ((p.v - prev.v) / (p.t - prev.t)) * 60 });
    prev = { t: p.t, v: p.v };
  }
  return rates;
}

/** "var/monitoring/counter/gang.txt" or "/var/monitoring/counter/gang.txt" -> "counter/gang"; anything else -> undefined. */
export function seriesIdFromPath(path: string): string | undefined {
  const prefix = MONITORING_DIR.slice(1);
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(".txt")) return undefined;
  return normalized.slice(prefix.length, -".txt".length);
}

function seriesPath(id: string): string {
  return `${MONITORING_DIR}${id}.txt`;
}

/** undefined on a missing or corrupt file, same shape as target_selector.ts's readWeightsFile. */
export function readSeries(ns: NS, id: string): Series | undefined {
  const raw = ns.read(seriesPath(id));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Series;
    return Array.isArray(parsed.values) && typeof parsed.start === "number" && typeof parsed.step === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeSeries(ns: NS, id: string, series: Series): void {
  ns.write(seriesPath(id), JSON.stringify(series), "w");
}

export function listSeries(ns: NS): string[] {
  return ns
    .ls("home", MONITORING_DIR)
    .map(seriesIdFromPath)
    .filter((id): id is string => id !== undefined)
    .sort();
}

/** "30m" / "2h" / "45s" / bare minutes -> seconds; undefined for anything else. */
export function parseWindow(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2] === "s" ? 1 : match[2] === "h" ? 3600 : 60;
  const seconds = Math.round(n * unit);
  return seconds > 0 ? seconds : undefined;
}

/**
 * Money earned per minute over the window: the sum of every money-source
 * counter that rose (gang, hacking, hacknet, ...). "total" is net of
 * spending, and "stock" rises on sales of shares bought earlier, so neither
 * counts. Undefined without monitoring data.
 */
export function incomePerMin(ns: NS, windowSec: number): number | undefined {
  const now = Math.floor(Date.now() / 1000);
  let total: number | undefined;
  for (const id of listSeries(ns)) {
    if (!id.startsWith("counter/") || id === "counter/total" || id === "counter/stock") continue;
    const series = readSeries(ns, id);
    const rate = series ? averageRatePerMin(series, now, windowSec) : undefined;
    if (rate !== undefined) total = (total ?? 0) + Math.max(0, rate);
  }
  return total;
}
