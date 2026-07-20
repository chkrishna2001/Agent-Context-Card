import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function gitShow(spec) {
  return execFileSync("git", ["show", spec], { encoding: "utf8" });
}

function stagedNames() {
  return new Set(
    execFileSync("git", ["diff", "--cached", "--name-only"], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter(Boolean),
  );
}

function inputs(staged) {
  if (!staged) {
    return {
      packageText: readFileSync("package.json", "utf8"),
      changelog: readFileSync("CHANGELOG.md", "utf8"),
    };
  }
  return {
    packageText: gitShow(":package.json"),
    changelog: gitShow(":CHANGELOG.md"),
  };
}

function validate(packageText, changelog, expectedTag) {
  const packageJson = JSON.parse(packageText);
  const version = packageJson.version;
  if (typeof version !== "string" || !SEMVER.test(version))
    throw new Error("package.json contains invalid semver: " + String(version));

  if (!/^## \[Unreleased\]\s*$/m.test(changelog))
    throw new Error("CHANGELOG.md must contain an [Unreleased] section.");

  const escaped = version.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
  const heading = new RegExp(
    "^## \\[" + escaped + "\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$",
    "m",
  );
  const match = changelog.match(heading);
  if (!match)
    throw new Error(
      "CHANGELOG.md must contain a dated section: ## [" +
        version +
        "] - YYYY-MM-DD",
    );
  const releaseDate = new Date(match[1] + "T00:00:00Z");
  if (
    Number.isNaN(releaseDate.valueOf()) ||
    releaseDate.toISOString().slice(0, 10) !== match[1]
  )
    throw new Error("CHANGELOG.md has an invalid date for " + version + ".");

  const sectionStart = match.index + match[0].length;
  const remaining = changelog.slice(sectionStart);
  const nextSection = remaining.search(/^## \[/m);
  const releaseNotes =
    nextSection >= 0 ? remaining.slice(0, nextSection) : remaining;
  if (!/^- .+\s*$/m.test(releaseNotes))
    throw new Error(
      "CHANGELOG.md release section " + version + " has no release notes.",
    );

  const linkVersion = version.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
  if (
    !new RegExp(
      "^\\[" + linkVersion + "\\]: .+/v" + linkVersion + "\\s*$",
      "m",
    ).test(changelog)
  )
    throw new Error(
      "CHANGELOG.md must define a release link ending in /v" + version + ".",
    );

  if (expectedTag && expectedTag !== "v" + version)
    throw new Error(
      "Tag " +
        expectedTag +
        " does not match package version " +
        version +
        "; expected v" +
        version +
        ".",
    );
  return version;
}

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const tagIndex = args.indexOf("--tag");
const expectedTag =
  tagIndex >= 0 ? args[tagIndex + 1] || process.env.GITHUB_REF_NAME : undefined;
if (tagIndex >= 0 && !expectedTag)
  throw new Error("--tag requires a tag name.");

const { packageText, changelog } = inputs(staged);
const version = validate(packageText, changelog, expectedTag);

if (staged) {
  let headVersion;
  try {
    headVersion = JSON.parse(gitShow("HEAD:package.json")).version;
  } catch {
    headVersion = undefined;
  }
  if (headVersion !== version) {
    const names = stagedNames();
    if (!names.has("package.json") || !names.has("CHANGELOG.md"))
      throw new Error(
        "A version change must stage both package.json and CHANGELOG.md.",
      );
  }
}

process.stdout.write(
  "Release metadata valid for " +
    version +
    (expectedTag ? " (" + expectedTag + ")" : "") +
    ".\n",
);
