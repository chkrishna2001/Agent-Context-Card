// Normalizes a small, conservative allow-list of search-style shell commands
// to {verb, pattern}, deliberately ignoring the trailing file/path arguments
// that vary between near-duplicate calls. Traced evidence from a live run:
// `grep -r "def as_set" sympy/core/relational.py sympy/core/expr.py ...`
// fired 5 times in 6 seconds with a slightly different trailing file list
// each time - never byte-identical, so exact-signature repeat detection
// never caught it. The actual search intent (verb + pattern) was unchanged
// every time; only the noise around it varied.
//
// Deliberately not a general command normalizer: only verbs whose first
// meaningful argument is unambiguously "the thing being searched for" are
// handled here (grep/rg/ag's leading pattern, find's -name/-iname value).
// Anything else returns undefined and stays on exact-signature detection
// only, per this project's deterministic-only-detection rule (AGENTS.md,
// "Ideas considered and rejected as defaults") - this is structural parsing
// of a known, fixed command shape, not a similarity score or classifier.
export type CommandSignature = { verb: string; pattern: string };

const SEARCH_VERBS = new Set(["grep", "rg", "ag"]);

export function commandSignature(
  command: string,
): CommandSignature | undefined {
  const tokens = tokenize(command);
  const verb = tokens[0];
  if (!verb) return undefined;

  if (SEARCH_VERBS.has(verb)) {
    // First non-flag token after the verb is the search pattern for all
    // three of these tools' basic invocation form.
    const pattern = tokens.slice(1).find((token) => !token.startsWith("-"));
    return pattern ? { verb, pattern } : undefined;
  }

  if (verb === "find") {
    // The -name/-iname value is the actual search target; the leading
    // path argument(s) vary just as much as grep's trailing file list and
    // shouldn't be part of this command's identity.
    const nameIndex = tokens.findIndex(
      (token) => token === "-name" || token === "-iname",
    );
    const pattern = nameIndex >= 0 ? tokens[nameIndex + 1] : undefined;
    return pattern ? { verb, pattern } : undefined;
  }

  return undefined;
}

// Minimal shell-token split: whitespace-separated, respecting simple single-
// or double-quoted spans. Not a full shell parser (no nested quoting or
// escape handling) - good enough to isolate a pattern argument from
// surrounding flags and paths, which is all this module needs.
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
