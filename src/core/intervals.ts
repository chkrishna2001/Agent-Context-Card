// Half-open [start, end) integer ranges, used to track which line ranges of
// a file have already been read so a later read whose entire requested
// range is already covered - even under completely different offset/limit
// arguments than any prior single call - can be recognized as redundant.
// Exact-signature matching alone misses this: a model oscillating between
// overlapping windows of the same large file rarely repeats byte-identical
// arguments, so it never trips a same-signature repeat counter at all.
export type Interval = [number, number];

export function mergeInterval(
  intervals: readonly Interval[],
  next: Interval,
): Interval[] {
  const [nextStart, nextEnd] = next;
  if (nextEnd <= nextStart) return [...intervals];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  let curStart = nextStart;
  let curEnd = nextEnd;
  let inserted = false;
  for (const [start, end] of sorted) {
    if (end < curStart) {
      merged.push([start, end]);
    } else if (start > curEnd) {
      if (!inserted) {
        merged.push([curStart, curEnd]);
        inserted = true;
      }
      merged.push([start, end]);
    } else {
      curStart = Math.min(curStart, start);
      curEnd = Math.max(curEnd, end);
    }
  }
  if (!inserted) merged.push([curStart, curEnd]);
  return merged;
}

export function isFullyCovered(
  intervals: readonly Interval[],
  range: Interval,
): boolean {
  const [start, end] = range;
  if (end <= start) return true;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let cursor = start;
  for (const [s, e] of sorted) {
    if (s > cursor) return false;
    if (e > cursor) cursor = e;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}
