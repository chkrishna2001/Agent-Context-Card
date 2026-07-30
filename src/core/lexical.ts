const CONTENT_WORD = /[a-z0-9][a-z0-9'_-]{2,}/gi;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "from",
  "have",
  "into",
  "just",
  "more",
  "need",
  "that",
  "the",
  "then",
  "this",
  "with",
]);

export function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]{3,}/g)
      ?.filter((term) => !STOP_WORDS.has(term)) ?? [],
  );
}

export function contentWordCount(text: string): number {
  return text.match(CONTENT_WORD)?.length ?? 0;
}
