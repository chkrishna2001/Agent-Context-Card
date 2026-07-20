import { execFileSync } from "node:child_process";

const tag = process.env.GITHUB_REF_NAME;
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REF_TYPE !== "tag" ||
  !tag
) {
  throw new Error(
    "Direct npm publishing is disabled. Create and push a version tag; publish.yml owns npm releases.",
  );
}

execFileSync(process.execPath, ["scripts/validate-release.mjs", "--tag", tag], {
  stdio: "inherit",
});
