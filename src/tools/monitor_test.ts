import { describe, expect, it } from "vitest";
import {
  aggregateByDirection,
  bandPolygon,
  ChartSeries,
  directionalRates,
  mergeSmallest,
  stackBands,
  formatMoney,
  formatSummary,
  niceTicks,
  parseAmount,
  parseWindow,
  plotPoints,
  timeTicks,
  yRange,
} from "tools/monitor";

describe("parseWindow", () => {
  it.each([
    ["30m", 1800],
    ["2h", 7200],
    ["45s", 45],
    ["90", 5400],
    ["1.5h", 5400],
    ["abc", undefined],
    ["", undefined],
    ["0", undefined],
    ["-5m", undefined],
  ])("%s -> %s", (raw, expected) => {
    expect(parseWindow(raw)).toBe(expected);
  });
});

describe("formatMoney", () => {
  it.each([
    [0, "$0"],
    [950, "$950"],
    [1_300_000_000, "$1.30B"],
    [78_200_000_000, "$78.2B"],
    [181_000_000_000, "$181B"],
    [-21_300_000_000, "-$21.3B"],
    [73_000_000, "$73.0M"],
  ])("%s -> %s", (n, expected) => {
    expect(formatMoney(n)).toBe(expected);
  });
});

describe("formatSummary", () => {
  const series = (values: (number | null)[]) => ({ start: 0, step: 60, values });

  it("groups counters into INCOME/SPEND by the sign of their change, largest first", () => {
    const lines = formatSummary(
      [
        { id: "counter/hacking", series: series([0, 1e9]) },
        { id: "counter/gang", series: series([0, 60e9]) },
        { id: "counter/augmentations", series: series([0, -20e9]) },
      ],
      60,
      3600
    );
    const text = lines.join("\n");

    expect(lines[1]).toMatch(/^INCOME\s+gang\s+\+\$60\.0B/);
    expect(lines[2]).toMatch(/^\s+hacking\s+\+\$1\.00B/);
    expect(lines[3]).toMatch(/^SPEND\s+augmentations\s+-\$20\.0B/);
    expect(text).toContain("(2 pts)");
  });

  it("drops counters that didn't change over the window", () => {
    const lines = formatSummary([{ id: "counter/crime", series: series([5e6, 5e6]) }, { id: "counter/gang", series: series([0, 1e9]) }], 60, 3600);

    expect(lines.join("\n")).not.toContain("crime");
  });

  it("shows gauges as start -> end, with hacking level as a plain number", () => {
    const lines = formatSummary(
      [
        { id: "gauge/net_worth", series: series([118e9, 181e9]) },
        { id: "gauge/hacking_level", series: series([858, 871]) },
      ],
      60,
      3600
    );
    const text = lines.join("\n");

    expect(text).toContain("net worth");
    expect(text).toContain("$118B → $181B");
    expect(text).toContain("858 → 871");
  });

  it("only counts points inside the window", () => {
    // Points at t=0,60,120; a 60s window ending at 120 sees only 60->120.
    const lines = formatSummary([{ id: "counter/gang", series: series([0, 10e9, 11e9]) }], 120, 60);

    expect(lines.join("\n")).toContain("+$1.00B");
  });

  it("explains itself when there's not enough data yet", () => {
    expect(formatSummary([{ id: "counter/gang", series: series([5]) }], 0, 3600)[0]).toMatch(/No monitoring data/);
  });
});

describe("aggregateByDirection", () => {
  const series = (values: (number | null)[]) => ({ start: 0, step: 60, values });

  it("sums per-minute rates into income and spend by each counter's direction, spend as a positive magnitude", () => {
    const { income, spend } = aggregateByDirection(
      [
        { id: "counter/gang", series: series([0, 60, 180]) }, // +60/min, +120/min
        { id: "counter/hacking", series: series([0, 6, 12]) }, // +6/min, +6/min
        { id: "counter/augmentations", series: series([0, -30, -30]) }, // -30/min, 0/min
        { id: "gauge/cash", series: series([1, 2, 3]) }, // gauges ignored
      ],
      120,
      3600
    );
    expect(income.points).toEqual([
      { t: 60, v: 66 },
      { t: 120, v: 126 },
    ]);
    expect(spend.points).toEqual([
      { t: 60, v: 30 },
      { t: 120, v: 0 },
    ]);
  });

  it("leaves out counters that didn't change over the window", () => {
    const { income, spend } = aggregateByDirection([{ id: "counter/crime", series: series([5, 5]) }], 60, 3600);
    expect(income.points).toEqual([]);
    expect(spend.points).toEqual([]);
  });
});

describe("parseAmount", () => {
  it.each([
    ["5B", 5e9],
    ["200m", 200e6],
    ["1.5T", 1.5e12],
    ["-3k", -3000],
    ["1200", 1200],
    ["0", 0],
    ["5X", undefined],
    ["", undefined],
    ["B", undefined],
  ])("%s -> %s", (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });
});

describe("niceTicks", () => {
  it("rounds bounds outward to nice steps (1/2/5 x 10^n)", () => {
    expect(niceTicks(1.37e9, 4.61e9)).toEqual({ lo: 1e9, hi: 5e9, ticks: [1e9, 2e9, 3e9, 4e9, 5e9] });
  });

  it("handles ranges crossing zero", () => {
    const { lo, hi, ticks } = niceTicks(-20.4e9, 4.56e9);
    expect(lo).toBeLessThanOrEqual(-20.4e9);
    expect(hi).toBeGreaterThanOrEqual(4.56e9);
    expect(ticks).toContain(0);
  });

  it("pads a flat series so the axis has height", () => {
    const { lo, hi } = niceTicks(5e9, 5e9);
    expect(lo).toBeLessThan(5e9);
    expect(hi).toBeGreaterThan(5e9);
  });

  it("pads an all-zero series too", () => {
    const { lo, hi } = niceTicks(0, 0);
    expect(hi).toBeGreaterThan(lo);
  });

  it("produces ticks without float noise", () => {
    for (const tick of niceTicks(0.1, 0.9).ticks) expect(String(tick).length).toBeLessThan(6);
  });
});

describe("yRange", () => {
  it("uses nice auto bounds when neither end is fixed", () => {
    expect(yRange([1.37e9, 4.61e9])).toEqual(niceTicks(1.37e9, 4.61e9));
  });

  it("uses a fixed --ymin/--ymax exactly, with 5 evenly spaced ticks", () => {
    expect(yRange([1.37e9, 4.61e9], 0, 8e9)).toEqual({ lo: 0, hi: 8e9, ticks: [0, 2e9, 4e9, 6e9, 8e9] });
  });

  it("fixes one end and auto-rounds the other", () => {
    const { lo, hi } = yRange([1.37e9, 4.61e9], 0);
    expect(lo).toBe(0);
    // 0..4.61B with ~5 ticks -> nice step 2B -> top rounds up to 6B.
    expect(hi).toBe(6e9);
  });

  it("works with no data (empty window)", () => {
    const { lo, hi } = yRange([]);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("plotPoints", () => {
  const pts = (pairs: [number, number | null][]) => pairs.map(([t, v]) => ({ t, v }));

  it("places points by timestamp and puts the max at the top (SVG y grows down)", () => {
    expect(plotPoints(pts([[0, 0], [100, 10]]), [0, 100], [0, 10], 200, 50)).toEqual([
      [
        { x: 0, y: 50 },
        { x: 200, y: 0 },
      ],
    ]);
  });

  it("positions a series that started late at its real time, not at the left edge", () => {
    const [seg] = plotPoints(pts([[50, 5], [100, 5]]), [0, 100], [0, 10], 200, 50);
    expect(seg[0].x).toBe(100);
  });

  it("clamps values outside a fixed y range to the edge", () => {
    const [seg] = plotPoints(pts([[0, -5], [100, 99]]), [0, 100], [0, 10], 100, 40);
    expect(seg.map((p) => p.y)).toEqual([40, 0]);
  });

  it("splits at nulls so a gap stays a gap", () => {
    const segments = plotPoints(pts([[0, 1], [10, 2], [20, null], [30, 3]]), [0, 30], [0, 3], 30, 10);
    expect(segments.map((s) => s.length)).toEqual([2, 1]);
  });

  it("drops points outside the x range (--window/--ago)", () => {
    const [seg] = plotPoints(pts([[0, 1], [50, 2], [200, 3]]), [40, 100], [0, 3], 60, 10);
    expect(seg).toHaveLength(1);
  });
});

describe("timeTicks", () => {
  it("lands on round clock times, not equal fractions of the window", () => {
    // 29-minute window starting at an odd second -> 5-minute ticks on exact multiples.
    const ticks = timeTicks(1758848000, 1758848000 + 29 * 60);
    for (const t of ticks) expect(t % 300).toBe(0);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
  });

  it("uses coarser steps for longer windows", () => {
    const ticks = timeTicks(0, 24 * 3600);
    expect(ticks[1] - ticks[0]).toBe(21600); // 6h steps for a day (3h would be 9 ticks, over the cap of 7)
  });

  it("falls back to the window edges when no round time fits", () => {
    expect(timeTicks(61, 119)).toEqual([61, 119]);
  });
});

describe("directionalRates", () => {
  const series = (values: (number | null)[]) => ({ start: 0, step: 60, values });

  it("returns one series per changed counter, split by direction, spend as positive magnitude", () => {
    const { income, spend } = directionalRates(
      [
        { id: "counter/gang", series: series([0, 60, 180]) },
        { id: "counter/hacknet_expenses", series: series([0, -30, -90]) },
        { id: "counter/crime", series: series([5, 5, 5]) },
        { id: "gauge/cash", series: series([1, 2, 3]) },
      ],
      120,
      3600
    );
    expect(income.map((s) => s.label)).toEqual(["gang"]);
    expect(income[0].points).toEqual([
      { t: 60, v: 60 },
      { t: 120, v: 120 },
    ]);
    expect(spend.map((s) => s.label)).toEqual(["hacknet expenses"]);
    expect(spend[0].points).toEqual([
      { t: 60, v: 30 },
      { t: 120, v: 60 },
    ]);
  });
});

const chartSeries = (label: string, pairs: [number, number | null][]): ChartSeries => ({
  label,
  format: String,
  points: pairs.map(([t, v]) => ({ t, v })),
});

describe("stackBands", () => {
  it("stacks the largest series at the bottom, each band starting where the one below ends", () => {
    const small = chartSeries("small", [
      [0, 1],
      [60, 1],
    ]);
    const big = chartSeries("big", [
      [0, 10],
      [60, 20],
    ]);
    const { times, layers } = stackBands([small, big], 0, 60);

    expect(times).toEqual([0, 60]);
    expect(layers.map((l) => l.index)).toEqual([1, 0]); // big first (bottom)
    expect(layers[0]).toEqual({ index: 1, lower: [0, 0], upper: [10, 20], total: 30 });
    expect(layers[1]).toEqual({ index: 0, lower: [10, 20], upper: [11, 21], total: 2 });
  });

  it("treats a missing or null point as 0 so the area has no holes", () => {
    const a = chartSeries("a", [
      [0, 5],
      [60, null],
    ]);
    const b = chartSeries("b", [[60, 3]]);
    const { layers } = stackBands([a, b], 0, 60);
    const aLayer = layers.find((l) => l.index === 0)!;
    const bLayer = layers.find((l) => l.index === 1)!;
    expect(aLayer.upper).toEqual([5, 0]);
    expect(bLayer.upper[0] - bLayer.lower[0]).toBe(0);
  });

  it("clamps negative points to 0 so a band never folds back through the one below", () => {
    const { layers } = stackBands([chartSeries("stock", [[0, -50], [60, 10]])], 0, 60);
    expect(layers[0].upper).toEqual([0, 10]);
  });

  it("ignores points outside [x0, x1]", () => {
    const { times } = stackBands([chartSeries("a", [[0, 1], [60, 2], [600, 3]])], 30, 120);
    expect(times).toEqual([60]);
  });
});

describe("mergeSmallest", () => {
  it("keeps the largest max-1 series and merges the rest into 'other', summed per time", () => {
    const series = [
      chartSeries("big", [[0, 100]]),
      chartSeries("tiny1", [[0, 1]]),
      chartSeries("mid", [[0, 50]]),
      chartSeries("tiny2", [[0, 2]]),
    ];
    const merged = mergeSmallest(series, 3);
    expect(merged.map((s) => s.label)).toEqual(["big", "mid", "other"]);
    expect(merged[2].points).toEqual([{ t: 0, v: 3 }]);
  });

  it("leaves a short list alone", () => {
    const series = [chartSeries("a", [[0, 1]])];
    expect(mergeSmallest(series, 8)).toBe(series);
  });
});

describe("bandPolygon", () => {
  it("traces the upper edge left to right, then the lower edge back, max at the top", () => {
    const poly = bandPolygon([0, 100], [0, 5], [10, 10], [0, 100], [0, 10], 200, 50);
    expect(poly).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 25 },
      { x: 0, y: 50 },
    ]);
  });

  it("clamps to a fixed y range", () => {
    const poly = bandPolygon([0], [0], [99], [0, 0], [0, 10], 10, 40);
    expect(poly[0].y).toBe(0);
  });
});
