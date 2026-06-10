import { describe, expect, it } from "vitest";
import { EMPTY_SUMMARY, percentile, summarize } from "./perf";

// These lock the stats contract that scripts/perf-analyze.mjs, the F3 overlay,
// and the server perfTracker all depend on — change percentile/summarize and
// every stored benchmark baseline silently shifts.

describe("percentile", () => {
  it("returns 0 for an empty input", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the single element regardless of p", () => {
    expect(percentile([5], 0)).toBe(5);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([5], 100)).toBe(5);
  });

  it("interpolates linearly between ranks", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([0, 10], 25)).toBe(2.5);
    expect(percentile([0, 10], 75)).toBe(7.5);
  });

  it("hits exact ranks without interpolation", () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 50)).toBe(2);
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });

  it("clamps p outside 0..100", () => {
    expect(percentile([1, 2, 3], -20)).toBe(1);
    expect(percentile([1, 2, 3], 150)).toBe(3);
  });
});

describe("summarize", () => {
  it("returns a copy of EMPTY_SUMMARY for an empty input (never the shared object)", () => {
    const s = summarize([]);
    expect(s).toEqual(EMPTY_SUMMARY);
    expect(s).not.toBe(EMPTY_SUMMARY);
  });

  it("computes count/min/max/avg/percentiles for a small window", () => {
    const s = summarize([1, 2, 3, 4]);
    expect(s.count).toBe(4);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.avg).toBe(2.5);
    expect(s.p50).toBe(2.5);
    // rank = 0.95 * 3 = 2.85 → 3·0.15 + 4·0.85
    expect(s.p95).toBeCloseTo(3.85, 10);
    // rank = 0.99 * 3 = 2.97 → 3·0.03 + 4·0.97
    expect(s.p99).toBeCloseTo(3.97, 10);
  });

  it("captures the tail of a skewed window in p99 but not p50", () => {
    const s = summarize([1, 1, 1, 100]);
    expect(s.p50).toBe(1);
    expect(s.avg).toBe(25.75);
    expect(s.p99).toBeCloseTo(1 * 0.03 + 100 * 0.97, 10);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
