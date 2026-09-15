import { describe, expect, test } from "bun:test";
import {
  isFullyCovered,
  mergeInterval,
  type Interval,
} from "../src/core/intervals";

describe("intervals", () => {
  test("mergeInterval adds a disjoint range as its own entry", () => {
    const merged = mergeInterval([[1, 51]], [500, 550]);
    expect(merged).toEqual([
      [1, 51],
      [500, 550],
    ]);
  });

  test("mergeInterval merges an overlapping range into one", () => {
    const merged = mergeInterval([[500, 550]], [515, 595]);
    expect(merged).toEqual([[500, 595]]);
  });

  test("mergeInterval merges an adjacent range with no gap", () => {
    const merged = mergeInterval([[1, 100]], [100, 200]);
    expect(merged).toEqual([[1, 200]]);
  });

  test("mergeInterval bridges two existing ranges the new one connects", () => {
    const merged = mergeInterval(
      [
        [1, 50],
        [200, 250],
      ],
      [40, 210],
    );
    expect(merged).toEqual([[1, 250]]);
  });

  test("mergeInterval ignores a degenerate or empty range", () => {
    expect(mergeInterval([[1, 50]], [10, 10])).toEqual([[1, 50]]);
    expect(mergeInterval([[1, 50]], [10, 5])).toEqual([[1, 50]]);
  });

  test("isFullyCovered is true when one interval fully contains the range", () => {
    expect(isFullyCovered([[1, 100]], [10, 50])).toBe(true);
    expect(isFullyCovered([[1, 100]], [1, 100])).toBe(true);
  });

  test("isFullyCovered is true when the range spans multiple adjoining intervals", () => {
    const covered: Interval[] = [
      [1, 50],
      [50, 100],
      [100, 150],
    ];
    expect(isFullyCovered(covered, [10, 140])).toBe(true);
  });

  test("isFullyCovered is false when there is a gap in the middle", () => {
    const covered: Interval[] = [
      [1, 50],
      [100, 150],
    ];
    expect(isFullyCovered(covered, [1, 150])).toBe(false);
  });

  test("isFullyCovered is false when the range extends past the last interval", () => {
    expect(isFullyCovered([[1, 100]], [50, 150])).toBe(false);
  });

  test("isFullyCovered is false against no coverage at all", () => {
    expect(isFullyCovered([], [1, 10])).toBe(false);
  });

  test("isFullyCovered is vacuously true for a degenerate/empty range", () => {
    expect(isFullyCovered([], [10, 10])).toBe(true);
    expect(isFullyCovered([[1, 5]], [20, 19])).toBe(true);
  });
});
