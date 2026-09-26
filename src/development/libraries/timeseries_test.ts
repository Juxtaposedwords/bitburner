import { describe, expect, it } from "vitest";
import { appendPoint, counterRates, seriesIdFromPath, windowPoints } from "development/libraries/timeseries";

describe("appendPoint", () => {
  it("starts a new series at the first point", () => {
    expect(appendPoint(undefined, 1000, 5, 60, 10)).toEqual({ start: 1000, step: 60, values: [5] });
  });

  it("appends the next slot", () => {
    const s = appendPoint({ start: 1000, step: 60, values: [5] }, 1060, 7, 60, 10);
    expect(s.values).toEqual([5, 7]);
  });

  it("rounds timer jitter into the nearest slot", () => {
    const s = appendPoint({ start: 1000, step: 60, values: [5] }, 1063, 7, 60, 10);
    expect(s.values).toEqual([5, 7]);
  });

  it("fills a gap with nulls rather than inventing data", () => {
    const s = appendPoint({ start: 1000, step: 60, values: [5] }, 1180, 9, 60, 10);
    expect(s.values).toEqual([5, null, null, 9]);
  });

  it("overwrites the last slot when sampled again within the same step", () => {
    const s = appendPoint({ start: 1000, step: 60, values: [5, 7] }, 1070, 8, 60, 10);
    expect(s.values).toEqual([5, 8]);
  });

  it("trims to capacity and advances start by the dropped points", () => {
    const s = appendPoint({ start: 1000, step: 60, values: [1, 2, 3] }, 1180, 4, 60, 3);
    expect(s).toEqual({ start: 1060, step: 60, values: [2, 3, 4] });
  });

  it("starts over when the gap exceeds the whole capacity", () => {
    const s = appendPoint({ start: 1000, step: 60, values: [1, 2] }, 1000 + 60 * 100, 9, 60, 3);
    expect(s).toEqual({ start: 7000, step: 60, values: [9] });
  });

  it("does not mutate the input series", () => {
    const input = { start: 1000, step: 60, values: [5] };
    appendPoint(input, 1060, 7, 60, 10);
    expect(input.values).toEqual([5]);
  });
});

describe("windowPoints", () => {
  it("returns only points inside [now - window, now], nulls included", () => {
    const series = { start: 1000, step: 60, values: [1, null, 3, 4] };
    expect(windowPoints(series, 1180, 120)).toEqual([
      { t: 1060, v: null },
      { t: 1120, v: 3 },
      { t: 1180, v: 4 },
    ]);
  });
});

describe("counterRates", () => {
  it("computes per-minute deltas between consecutive points", () => {
    const rates = counterRates([
      { t: 0, v: 100 },
      { t: 60, v: 160 },
      { t: 120, v: 280 },
    ]);
    expect(rates).toEqual([
      { t: 60, perMin: 60 },
      { t: 120, perMin: 120 },
    ]);
  });

  it("reports negative rates for a downward counter - spend categories accumulate negatively", () => {
    const rates = counterRates([
      { t: 0, v: -100 },
      { t: 60, v: -400 },
    ]);
    expect(rates).toEqual([{ t: 60, perMin: -300 }]);
  });

  it("emits null for a gap and measures the next rate across the gap", () => {
    const rates = counterRates([
      { t: 0, v: 0 },
      { t: 60, v: null },
      { t: 120, v: 240 },
    ]);
    expect(rates).toEqual([
      { t: 60, perMin: null },
      { t: 120, perMin: 120 },
    ]);
  });

  it("skips leading nulls before the first real point", () => {
    expect(counterRates([{ t: 0, v: null }, { t: 60, v: 5 }])).toEqual([]);
  });
});

describe("seriesIdFromPath", () => {
  it.each([
    ["var/monitoring/counter/gang.txt", "counter/gang"],
    ["/var/monitoring/gauge/net_worth.txt", "gauge/net_worth"],
    ["var/log/home/stock_daemon.txt", undefined],
    ["var/monitoring/counter/gang.js", undefined],
  ])("%s -> %s", (path, expected) => {
    expect(seriesIdFromPath(path)).toBe(expected);
  });
});
