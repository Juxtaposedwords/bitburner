import { AutocompleteData, NS } from "@ns";
import type ReactNamespace from "react";
import { counterRates, listSeries, readSeries, Series, seriesIdFromPath, windowPoints } from "development/libraries/timeseries";

/**
 * Reads the time series monitoring_daemon.ts records under /var/monitoring/.
 *
 *   run tools/monitor.js [--window 1h]        summary table (text - the one to paste)
 *   run tools/monitor.js --graph <id>[,<id>...] [--window 2h] [--ago 1h]
 *                        [--ymin 0] [--ymax 5B] [--overlay | --stack]
 *                                             SVG chart, up to 4 series; presets: income, spend.
 *                                             --stack: stacked area; `income`/`spend` alone
 *                                             expand into their categories
 *   run tools/monitor.js --list               series ids and spans
 *
 * Windows/--ago accept 30m / 2h / 45s or bare minutes; --ymin/--ymax accept
 * 500M / 5B / 1.5T or plain numbers.
 */
const DEFAULT_WINDOW_SEC = 3600;
const WINDOW_FLAG = "--window";
const AGO_FLAG = "--ago";
const GRAPH_FLAG = "--graph";
const LIST_FLAG = "--list";
const YMIN_FLAG = "--ymin";
const YMAX_FLAG = "--ymax";
const OVERLAY_FLAG = "--overlay";
const STACK_FLAG = "--stack";

// Gauges that aren't money - shown as plain integers.
const NON_MONEY_GAUGES = new Set(["gauge/hacking_level"]);

/** "30m" / "2h" / "45s" / bare minutes -> seconds; undefined for anything else. */
export function parseWindow(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2] === "s" ? 1 : match[2] === "h" ? 3600 : 60;
  const seconds = Math.round(n * unit);
  return seconds > 0 ? seconds : undefined;
}

export function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const units: [number, string][] = [
    [1e15, "q"],
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = abs / size;
      return `${sign}$${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)}${suffix}`;
    }
  }
  return `${sign}$${abs.toFixed(0)}`;
}

function formatSigned(n: number): string {
  return n > 0 ? `+${formatMoney(n)}` : formatMoney(n);
}

function formatPlain(n: number): string {
  return n.toFixed(0);
}

function formatGauge(id: string, n: number): string {
  return NON_MONEY_GAUGES.has(id) ? formatPlain(n) : formatMoney(n);
}

function formatClock(t: number): string {
  return new Date(t * 1000).toTimeString().slice(0, 5);
}

function displayName(id: string): string {
  return id.slice(id.indexOf("/") + 1).replace(/_/g, " ");
}

function nonNull(points: { t: number; v: number | null }[]): { t: number; v: number }[] {
  return points.filter((p): p is { t: number; v: number } => p.v !== null);
}

/**
 * Counters are grouped into INCOME/SPEND by the sign of their change over
 * the window (nothing hardcoded about which game categories are which),
 * sorted by size; unchanged counters are dropped. Gauges show start -> end.
 */
export function formatSummary(all: { id: string; series: Series }[], now: number, windowSec: number): string[] {
  type CounterRow = { name: string; delta: number; perMin: number; minRate?: number; maxRate?: number };
  const income: CounterRow[] = [];
  const spend: CounterRow[] = [];
  const gauges: string[] = [];
  let firstT = Infinity;
  let lastT = -Infinity;
  let maxPoints = 0;

  for (const { id, series } of all) {
    const points = windowPoints(series, now, windowSec);
    const real = nonNull(points);
    if (real.length < 2) continue;
    const first = real[0];
    const last = real[real.length - 1];
    firstT = Math.min(firstT, first.t);
    lastT = Math.max(lastT, last.t);
    maxPoints = Math.max(maxPoints, points.length);

    if (id.startsWith("counter/")) {
      const delta = last.v - first.v;
      if (delta === 0) continue;
      const rates = counterRates(points)
        .map((r) => r.perMin)
        .filter((r): r is number => r !== null);
      const row: CounterRow = {
        name: displayName(id),
        delta,
        perMin: delta / ((last.t - first.t) / 60),
        minRate: rates.length > 0 ? Math.min(...rates) : undefined,
        maxRate: rates.length > 0 ? Math.max(...rates) : undefined,
      };
      (delta > 0 ? income : spend).push(row);
    } else if (id.startsWith("gauge/")) {
      gauges.push(`${displayName(id).padEnd(18)} ${formatGauge(id, first.v)} → ${formatGauge(id, last.v)}`);
    }
  }

  if (!Number.isFinite(firstT)) {
    return ["No monitoring data in this window yet - monitoring_daemon.js samples once a minute (needs 2+ points)."];
  }

  const rowText = (r: CounterRow): string => {
    const range = r.minRate !== undefined && r.maxRate !== undefined ? `${formatMoney(r.minRate)} / ${formatMoney(r.maxRate)}` : "";
    return `${r.name.padEnd(22)}${formatSigned(r.delta).padStart(10)}${formatSigned(r.perMin).padStart(10)}   ${range}`;
  };
  const bySize = (a: CounterRow, b: CounterRow): number => Math.abs(b.delta) - Math.abs(a.delta);
  const section = (label: string, rows: string[]): string[] =>
    rows.map((row, i) => `${(i === 0 ? label : "").padEnd(9)}${row}`);

  return [
    `window ${formatClock(firstT)}-${formatClock(lastT)} (${maxPoints} pts)`.padEnd(31) + "Δ total".padStart(10) + "/min".padStart(10) + "   min / max rate",
    ...section("INCOME", income.sort(bySize).map(rowText)),
    ...section("SPEND", spend.sort(bySize).map(rowText)),
    ...section("GAUGES", gauges),
  ];
}

// --- Charts (SVG via ns.tprintRaw) ---------------------------------------

/** One chart series. `format` labels its y-axis ticks. */
export type ChartSeries = { label: string; points: { t: number; v: number | null }[]; format: (n: number) => string };

/**
 * The `income`/`spend` presets: sum the per-minute rates of every counter,
 * split by the sign of each counter's change over the window (the same rule
 * formatSummary uses), with spend reported as a positive magnitude.
 */
export function aggregateByDirection(all: { id: string; series: Series }[], now: number, windowSec: number): { income: ChartSeries; spend: ChartSeries } {
  const { income, spend } = directionalRates(all, now, windowSec);
  const sum = (components: ChartSeries[]): { t: number; v: number }[] => {
    const byT = new Map<number, number>();
    for (const s of components) for (const p of nonNull(s.points)) byT.set(p.t, (byT.get(p.t) ?? 0) + p.v);
    return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  };
  return {
    income: { label: "income /min", points: sum(income), format: formatMoney },
    spend: { label: "spend /min", points: sum(spend), format: formatMoney },
  };
}

/** "5B" / "200m" / "1.5T" / "-3k" / "1200" -> number; undefined for anything else. Case-insensitive. */
export function parseAmount(raw: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?)([kmbtq]?)$/i.exec(raw.trim());
  if (!match) return undefined;
  const scale: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };
  return Number(match[1]) * scale[match[2].toLowerCase()];
}

/**
 * Rounded y-axis bounds and tick values around [min, max] - the standard
 * "nice numbers" approach (steps of 1, 2, 5 or 10 x a power of ten), so ticks
 * land on $1B/$2B/... rather than $1.37B/$2.61B. A flat series is padded so
 * it doesn't collapse to a zero-height axis.
 */
export function niceTicks(min: number, max: number, count = 5): { lo: number; hi: number; ticks: number[] } {
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const niceStep = (raw: number): number => {
    const exp = Math.floor(Math.log10(raw));
    const f = raw / 10 ** exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * 10 ** exp;
  };
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Rounding each tick avoids float noise like 0.30000000000000004.
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { lo, hi, ticks };
}

/**
 * The y range for one panel: niceTicks over its data, with --ymin/--ymax
 * overriding either end. A fixed end is used exactly (not rounded), and the
 * ticks become evenly spaced between the final bounds.
 */
export function yRange(values: number[], ymin?: number, ymax?: number): { lo: number; hi: number; ticks: number[] } {
  const dataMin = values.length > 0 ? Math.min(...values) : 0;
  const dataMax = values.length > 0 ? Math.max(...values) : 1;
  if (ymin === undefined && ymax === undefined) return niceTicks(dataMin, dataMax);

  const auto = niceTicks(ymin ?? dataMin, ymax ?? dataMax);
  const lo = ymin ?? auto.lo;
  const hi = ymax ?? auto.hi;
  if (hi <= lo) return niceTicks(lo, lo);
  const ticks = Array.from({ length: 5 }, (_, i) => Number((lo + ((hi - lo) * i) / 4).toPrecision(12)));
  return { lo, hi, ticks };
}

/**
 * Polyline geometry for one series: places each point by its *timestamp*
 * within [x0, x1] (so a series that started recording late sits where it
 * belongs on the time axis), scales y into [lo, hi] with the max at the top
 * (SVG y grows downward), clamps out-of-range values to the edge (for a
 * fixed --ymin/--ymax), and splits at nulls so a gap stays a gap.
 */
export function plotPoints(
  points: { t: number; v: number | null }[],
  [x0, x1]: [number, number],
  [lo, hi]: [number, number],
  w: number,
  h: number
): { x: number; y: number }[][] {
  const round = (n: number): number => Math.round(n * 10) / 10;
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.t < x0 || p.t > x1) continue;
    if (p.v === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    const clamped = Math.min(hi, Math.max(lo, p.v));
    current.push({
      x: round(x1 === x0 ? 0 : ((p.t - x0) / (x1 - x0)) * w),
      y: round(hi === lo ? h / 2 : h - ((clamped - lo) / (hi - lo)) * h),
    });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Per-category per-minute rates for every counter that changed over the
 * window, split into income and spend by the sign of that change (the same
 * rule formatSummary uses). Spend is a positive magnitude, so both sides can
 * be stacked upward. The `income`/`spend` presets and `--stack` build on this.
 */
export function directionalRates(all: { id: string; series: Series }[], now: number, windowSec: number): { income: ChartSeries[]; spend: ChartSeries[] } {
  const income: ChartSeries[] = [];
  const spend: ChartSeries[] = [];
  for (const { id, series } of all) {
    if (!id.startsWith("counter/")) continue;
    const points = windowPoints(series, now, windowSec);
    const real = nonNull(points);
    if (real.length < 2) continue;
    const delta = real[real.length - 1].v - real[0].v;
    if (delta === 0) continue;
    const sign = delta > 0 ? 1 : -1;
    const rates = counterRates(points).map((r) => ({ t: r.t, v: r.perMin === null ? null : sign * r.perMin }));
    (delta > 0 ? income : spend).push({ label: displayName(id), points: rates, format: formatMoney });
  }
  return { income, spend };
}

/** One band of a stacked area: which input series it is, its lower and upper edges at each shared time, and its total over the window. */
export type StackLayer = { index: number; lower: number[]; upper: number[]; total: number };

/**
 * Stacks series into bands on a shared time axis (points within [x0, x1]).
 * Largest total goes at the bottom, where the baseline is flat and its shape
 * is easiest to read. A missing or null point counts as 0 (an area can't
 * have holes), and a negative point is clamped to 0 - an income category
 * can dip below zero for a minute (e.g. a realized stock loss), which would
 * otherwise fold its band back through the one below it.
 */
export function stackBands(series: ChartSeries[], x0: number, x1: number): { times: number[]; layers: StackLayer[] } {
  const inRange = series.map((s) => s.points.filter((p) => p.t >= x0 && p.t <= x1));
  const times = [...new Set(inRange.flatMap((pts) => pts.map((p) => p.t)))].sort((a, b) => a - b);
  const values = inRange.map((pts) => {
    const byT = new Map(pts.map((p) => [p.t, p.v]));
    return times.map((t) => Math.max(0, byT.get(t) ?? 0));
  });
  const totals = values.map((vals) => vals.reduce((a, b) => a + b, 0));
  const order = series.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);

  const running = times.map(() => 0);
  const layers = order.map((index) => {
    const lower = [...running];
    values[index].forEach((v, k) => (running[k] += v));
    return { index, lower, upper: [...running], total: totals[index] };
  });
  return { times, layers };
}

/**
 * Keeps the `max - 1` largest series and merges the rest into one "other"
 * series (summed per timestamp), so a stack never needs more colors than
 * the palette has.
 */
export function mergeSmallest(series: ChartSeries[], max: number): ChartSeries[] {
  if (series.length <= max) return series;
  const total = (s: ChartSeries): number => nonNull(s.points).reduce((sum, p) => sum + Math.max(0, p.v), 0);
  const sorted = [...series].sort((a, b) => total(b) - total(a));
  const keep = sorted.slice(0, max - 1);
  const sums = new Map<number, number>();
  for (const s of sorted.slice(max - 1)) {
    for (const p of nonNull(s.points)) sums.set(p.t, (sums.get(p.t) ?? 0) + p.v);
  }
  const other = [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  return [...keep, { label: "other", points: other, format: keep[0].format }];
}

/**
 * Polygon for one stacked band: the upper edge left to right, then the lower
 * edge right to left, in plot coordinates (max at the top). Values beyond a
 * fixed [lo, hi] are clamped to the edge.
 */
export function bandPolygon(
  times: number[],
  lower: number[],
  upper: number[],
  [x0, x1]: [number, number],
  [lo, hi]: [number, number],
  w: number,
  h: number
): { x: number; y: number }[] {
  const round = (n: number): number => Math.round(n * 10) / 10;
  const x = (t: number): number => round(x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * w);
  const y = (v: number): number => round(hi === lo ? h / 2 : h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h);
  const top = times.map((t, k) => ({ x: x(t), y: y(upper[k]) }));
  const bottom = times.map((t, k) => ({ x: x(t), y: y(lower[k]) })).reverse();
  return [...top, ...bottom];
}

export type ChartOptions = { x0: number; x1: number; ymin?: number; ymax?: number; overlay: boolean };

const SVG_COLORS = ["#4ade80", "#22d3ee", "#facc15", "#e879f9", "#fb923c", "#60a5fa", "#f87171", "#a3e635"];
// Line charts stay at 4 lines - more gets unreadable. Stacks can use the whole palette.
export const MAX_SERIES = 4;
export const MAX_STACK = SVG_COLORS.length;
const TIME_STEPS_SEC = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/**
 * X-axis ticks on round clock times (every 5m, 10m, 1h, ...) rather than
 * equal fractions of the window, which landed on odd minutes like 17:53 and
 * 17:59. Picks the smallest step giving at most `maxTicks` ticks. Falls back
 * to the window's two edges if no round time fits inside it.
 */
export function timeTicks(x0: number, x1: number, maxTicks = 7): number[] {
  const span = x1 - x0;
  const step = TIME_STEPS_SEC.find((s) => span / s <= maxTicks) ?? TIME_STEPS_SEC[TIME_STEPS_SEC.length - 1];
  const ticks: number[] = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) ticks.push(t);
  return ticks.length > 0 ? ticks : [x0, x1];
}
type ReactLib = typeof ReactNamespace;

/**
 * Stacked panels (one per series, each with its own y-axis) or, with
 * `overlay`, a single panel where every series shares one y-axis. Printed
 * with ns.tprintRaw (0 GB). React comes from globalThis.React, not
 * lib/react.ts: Bitburner's RAM calculator (RamCalculations.ts) charges
 * 25 GB to any script that references the identifier `window` or
 * `document`, which lib/react.ts does; globalThis is the same object and
 * isn't charged.
 */
type Drawing = {
  h: ReactLib["createElement"];
  children: ReactNamespace.ReactElement[];
  text: (x: number, y: number, content: string, extra?: Record<string, unknown>) => ReactNamespace.ReactElement;
};

const PLOT_LEFT = 76;
const PLOT_WIDTH = 560;

function newDrawing(React: ReactLib, title: string): Drawing {
  const h = React.createElement;
  const text = (x: number, y: number, content: string, extra: Record<string, unknown> = {}) =>
    h("text", { x, y, fill: "#bbb", fontSize: 11, fontFamily: "monospace", ...extra }, content);
  return { h, text, children: [text(0, 16, title, { fontSize: 14, fill: "#eee" })] };
}

/** Frame, y gridlines + tick labels, x gridlines + time labels for one panel whose top edge is at y0. */
function drawAxes(
  d: Drawing,
  y0: number,
  panelH: number,
  { lo, hi, ticks }: { lo: number; hi: number; ticks: number[] },
  format: (n: number) => string,
  [x0, x1]: [number, number]
): void {
  const xOf = (t: number): number => PLOT_LEFT + ((t - x0) / (x1 - x0 || 1)) * PLOT_WIDTH;
  for (const tick of ticks) {
    const ty = y0 + (hi === lo ? panelH / 2 : panelH - ((tick - lo) / (hi - lo)) * panelH);
    d.children.push(d.h("line", { x1: PLOT_LEFT, x2: PLOT_LEFT + PLOT_WIDTH, y1: ty, y2: ty, stroke: "#333" }));
    d.children.push(d.text(PLOT_LEFT - 6, ty + 4, format(tick), { textAnchor: "end" }));
  }
  for (const t of timeTicks(x0, x1)) {
    d.children.push(d.h("line", { x1: xOf(t), x2: xOf(t), y1: y0, y2: y0 + panelH, stroke: "#2a2a2a" }));
    d.children.push(d.text(xOf(t), y0 + panelH + 14, formatClock(t), { textAnchor: "middle" }));
  }
  d.children.push(d.h("rect", { x: PLOT_LEFT, y: y0, width: PLOT_WIDTH, height: panelH, fill: "none", stroke: "#555" }));
}

/**
 * Line chart: stacked panels (one per series, each with its own y-axis) or,
 * with `overlay`, a single panel where every series shares one y-axis.
 * Printed with ns.tprintRaw (0 GB). React comes from globalThis.React, not
 * lib/react.ts: Bitburner's RAM calculator (RamCalculations.ts) charges
 * 25 GB to any script that references the identifier `window` or
 * `document`, which lib/react.ts does; globalThis is the same object and
 * isn't charged.
 */
export function buildChart(React: ReactLib, title: string, series: ChartSeries[], opts: ChartOptions): ReactNamespace.ReactElement {
  const d = newDrawing(React, title);
  const panelH = opts.overlay ? 200 : 110;
  const panelGap = 40;
  const top = 30;
  const groups: number[][] = opts.overlay ? [series.map((_, i) => i)] : series.map((_, i) => [i]);

  groups.forEach((members, gi) => {
    const y0 = top + gi * (panelH + panelGap) + 16;
    const values = members.flatMap((i) => nonNull(series[i].points.filter((p) => p.t >= opts.x0 && p.t <= opts.x1)).map((p) => p.v));
    const range = yRange(values, opts.ymin, opts.ymax);

    // Panel heading: the series name(s), in their line colors.
    let hx = PLOT_LEFT;
    for (const i of members) {
      d.children.push(d.text(hx, y0 - 6, series[i].label, { fill: SVG_COLORS[i], fontSize: 12 }));
      hx += series[i].label.length * 7.5 + 18;
    }

    drawAxes(d, y0, panelH, range, series[members[0]].format, [opts.x0, opts.x1]);
    if (values.length === 0) d.children.push(d.text(PLOT_LEFT + 10, y0 + panelH / 2, "(no data in window)"));

    for (const i of members) {
      for (const seg of plotPoints(series[i].points, [opts.x0, opts.x1], [range.lo, range.hi], PLOT_WIDTH, panelH)) {
        d.children.push(
          seg.length === 1
            ? d.h("circle", { cx: PLOT_LEFT + seg[0].x, cy: y0 + seg[0].y, r: 2.5, fill: SVG_COLORS[i] })
            : d.h("polyline", {
                points: seg.map((p) => `${PLOT_LEFT + p.x},${y0 + p.y}`).join(" "),
                fill: "none",
                stroke: SVG_COLORS[i],
                strokeWidth: 2,
              })
        );
      }
    }
  });

  const height = top + groups.length * (panelH + panelGap) + 10;
  return d.h("svg", { width: PLOT_LEFT + PLOT_WIDTH + 20, height, style: { display: "block" } }, ...d.children);
}

/**
 * Stacked area chart: each series is a filled band on top of the ones below
 * it, so the top edge is the total and each band is one source's share.
 * Largest at the bottom (see stackBands). The legend sits to the right in
 * the same top-to-bottom order as the bands, with each series' share of
 * the window's total. The y-axis starts at 0 unless --ymin says otherwise.
 */
export function buildStackedChart(React: ReactLib, title: string, series: ChartSeries[], opts: ChartOptions): ReactNamespace.ReactElement {
  const d = newDrawing(React, title);
  const panelH = 220;
  const y0 = 46;
  const { times, layers } = stackBands(series, opts.x0, opts.x1);
  const tops = layers.length > 0 ? layers[layers.length - 1].upper : [];
  const range = yRange(tops.length > 0 ? [...tops, 0] : [], opts.ymin ?? 0, opts.ymax);
  const grandTotal = layers.reduce((sum, l) => sum + l.total, 0);

  drawAxes(d, y0, panelH, range, series[0]?.format ?? formatMoney, [opts.x0, opts.x1]);
  if (times.length === 0) d.children.push(d.text(PLOT_LEFT + 10, y0 + panelH / 2, "(no data in window)"));

  layers.forEach((layer, k) => {
    const color = SVG_COLORS[k % SVG_COLORS.length];
    const polygon = bandPolygon(times, layer.lower, layer.upper, [opts.x0, opts.x1], [range.lo, range.hi], PLOT_WIDTH, panelH);
    d.children.push(
      d.h("polygon", {
        points: polygon.map((p) => `${PLOT_LEFT + p.x},${y0 + p.y}`).join(" "),
        fill: color,
        fillOpacity: 0.7,
        stroke: color,
        strokeWidth: 1,
      })
    );
  });

  // Legend: top band first, matching the visual stack.
  const legendX = PLOT_LEFT + PLOT_WIDTH + 14;
  [...layers].reverse().forEach((layer, row) => {
    const k = layers.length - 1 - row;
    const share = grandTotal > 0 ? Math.round((layer.total / grandTotal) * 100) : 0;
    const ly = y0 + 10 + row * 18;
    d.children.push(d.h("rect", { x: legendX, y: ly - 9, width: 10, height: 10, fill: SVG_COLORS[k % SVG_COLORS.length] }));
    d.children.push(d.text(legendX + 16, ly, `${series[layer.index].label} ${share}%`, { fill: "#ddd" }));
  });

  return d.h("svg", { width: legendX + 190, height: y0 + panelH + 30, style: { display: "block" } }, ...d.children);
}

// --- CLI ----------------------------------------------------------------

const PRESETS = ["income", "spend"];

function readAll(ns: NS): { id: string; series: Series }[] {
  return listSeries(ns)
    .map((id) => ({ id, series: readSeries(ns, id) }))
    .filter((s): s is { id: string; series: Series } => s.series !== undefined);
}

/**
 * Resolves `--graph a,b,...` into chart series: counters plotted as
 * per-minute rate (spend counters as a positive magnitude, labeled "spent",
 * so higher always means more money moving), gauges as value, and the
 * `income`/`spend` presets. `now`/`windowSec` bound the data to the x-axis.
 */
function resolveSeries(ns: NS, rawIds: string, now: number, windowSec: number, sharedAxis: boolean, stack = false): ChartSeries[] | string {
  const ids = rawIds.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  const limit = stack ? MAX_STACK : MAX_SERIES;
  if (ids.length > limit) return `at most ${limit} series per graph`;

  // `--stack` on a lone preset breaks it into its categories - the
  // "where does income come from" view.
  if (stack && ids.length === 1 && PRESETS.includes(ids[0])) {
    const { income, spend } = directionalRates(readAll(ns), now, windowSec);
    const components = ids[0] === "income" ? income : spend;
    return components.length > 0 ? mergeSmallest(components, MAX_STACK) : `no ${ids[0]} categories changed in this window yet`;
  }

  const presets = ids.some((id) => PRESETS.includes(id)) ? aggregateByDirection(readAll(ns), now, windowSec) : undefined;
  const series: ChartSeries[] = [];
  for (const id of ids) {
    if (presets && id === "income") {
      series.push(presets.income);
      continue;
    }
    if (presets && id === "spend") {
      series.push(presets.spend);
      continue;
    }
    const stored = readSeries(ns, id);
    if (!stored) return `no series "${id}" - see run tools/monitor.js ${LIST_FLAG} (presets: ${PRESETS.join(", ")})`;
    const points = windowPoints(stored, now, windowSec);

    if (id.startsWith("counter/")) {
      const real = nonNull(points);
      const spending = real.length >= 2 && real[real.length - 1].v < real[0].v;
      const rates = counterRates(points).map((r) => ({ t: r.t, v: r.perMin === null ? null : spending ? -r.perMin : r.perMin }));
      series.push({ label: `${displayName(id)} (${spending ? "spent" : "earned"} /min)`, points: rates, format: formatMoney });
    } else {
      series.push({ label: displayName(id), points, format: NON_MONEY_GAUGES.has(id) ? formatPlain : formatMoney });
    }
  }

  // One shared y-axis can't label money and a plain number at once.
  if (sharedAxis && new Set(series.map((s) => s.format)).size > 1) {
    return `${stack ? STACK_FLAG : OVERLAY_FLAG} needs series in the same units - graph hacking level separately`;
  }
  return series;
}

type Args = {
  windowSec: number;
  agoSec: number;
  graph?: string;
  list: boolean;
  overlay: boolean;
  stack: boolean;
  ymin?: number;
  ymax?: number;
  error?: string;
};

function parseArgs(rawArgs: (string | number | boolean)[]): Args {
  const args = rawArgs.map(String);
  const parsed: Args = { windowSec: DEFAULT_WINDOW_SEC, agoSec: 0, list: false, overlay: false, stack: false };
  const fail = (error: string): Args => ({ ...parsed, error });

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1] ?? "";
    if (flag === WINDOW_FLAG || flag === AGO_FLAG) {
      const seconds = parseWindow(next);
      if (seconds === undefined) return fail(`bad ${flag} value "${next}" (try 30m, 2h, 90)`);
      if (flag === WINDOW_FLAG) parsed.windowSec = seconds;
      else parsed.agoSec = seconds;
      i++;
    } else if (flag === YMIN_FLAG || flag === YMAX_FLAG) {
      const amount = parseAmount(next);
      if (amount === undefined) return fail(`bad ${flag} value "${next}" (try 0, 500M, 5B)`);
      if (flag === YMIN_FLAG) parsed.ymin = amount;
      else parsed.ymax = amount;
      i++;
    } else if (flag === GRAPH_FLAG) {
      if (!next) return fail(`${GRAPH_FLAG} needs a series id (see ${LIST_FLAG})`);
      parsed.graph = next;
      i++;
    } else if (flag === LIST_FLAG) {
      parsed.list = true;
    } else if (flag === OVERLAY_FLAG) {
      parsed.overlay = true;
    } else if (flag === STACK_FLAG) {
      parsed.stack = true;
    } else {
      return fail(`unknown argument "${flag}"`);
    }
  }

  if (parsed.overlay && parsed.stack) return fail(`${OVERLAY_FLAG} and ${STACK_FLAG} are two different charts - pick one`);
  if (parsed.ymin !== undefined && parsed.ymax !== undefined && parsed.ymax <= parsed.ymin) {
    return fail(`${YMAX_FLAG} must be greater than ${YMIN_FLAG}`);
  }
  return parsed;
}

export function autocomplete(data: AutocompleteData, args: string[]): string[] {
  const last = args[args.length - 1];
  if (last === GRAPH_FLAG) return [...PRESETS, ...data.txts.map(seriesIdFromPath).filter((id): id is string => id !== undefined)];
  if (last === WINDOW_FLAG || last === AGO_FLAG) return ["15m", "30m", "1h", "2h", "6h", "24h"];
  if (last === YMIN_FLAG || last === YMAX_FLAG) return ["0", "100M", "1B", "5B", "10B"];
  return [WINDOW_FLAG, GRAPH_FLAG, LIST_FLAG, AGO_FLAG, YMIN_FLAG, YMAX_FLAG, OVERLAY_FLAG, STACK_FLAG];
}

const USAGE =
  "Usage: run tools/monitor.js [--window 1h] [--ago 0]\n" +
  "       run tools/monitor.js --graph <id>[,<id>...] [--window 2h] [--ago 1h] [--ymin 0] [--ymax 5B] [--overlay | --stack]\n" +
  "       run tools/monitor.js --list";

export async function main(ns: NS): Promise<void> {
  const args = parseArgs(ns.args);
  if (args.error) {
    ns.tprintf("%s", `[Monitor] ERROR: ${args.error}.\n${USAGE}`);
    return;
  }

  // --ago shifts the whole x-axis back; everything below treats `end` as "now".
  const end = Math.floor(Date.now() / 1000) - args.agoSec;

  if (args.graph) {
    const series = resolveSeries(ns, args.graph, end, args.windowSec, args.overlay || args.stack, args.stack);
    if (typeof series === "string") {
      ns.tprintf("%s", `[Monitor] ERROR: ${series}.`);
      return;
    }
    const React = (globalThis as unknown as { React?: ReactLib }).React;
    if (!React) {
      ns.tprintf("%s", "[Monitor] ERROR: React isn't available on globalThis in this Bitburner build.");
      return;
    }
    const opts: ChartOptions = { x0: end - args.windowSec, x1: end, ymin: args.ymin, ymax: args.ymax, overlay: args.overlay };
    const title = args.graph.split(",").join(" vs ");
    const chart = args.stack
      ? buildStackedChart(React, `${title}${PRESETS.includes(args.graph) ? " by category" : ""}  (per minute, stacked)`, series, opts)
      : buildChart(React, title, series, opts);
    // NetscriptDefinitions' ReactNode is a simplified stand-in for React's
    // own type; the element is a real React element at runtime.
    ns.tprintRaw(chart as unknown as Parameters<NS["tprintRaw"]>[0]);
    return;
  }

  if (args.list) {
    const ids = listSeries(ns);
    const lines =
      ids.length === 0
        ? ["No series yet under /var/monitoring/ - is monitoring_daemon.js running?"]
        : ids.map((id) => {
            const s = readSeries(ns, id);
            if (!s) return `${id.padEnd(32)} (unreadable)`;
            const last = s.start + (s.values.length - 1) * s.step;
            return `${id.padEnd(32)} ${String(s.values.length).padStart(5)} pts  ${formatClock(s.start)}-${formatClock(last)}`;
          });
    ns.tprintf("%s", lines.join("\n"));
    return;
  }

  ns.tprintf("%s", formatSummary(readAll(ns), end, args.windowSec).join("\n"));
}
