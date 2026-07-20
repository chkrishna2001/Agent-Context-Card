import { execFileSync } from "node:child_process";

const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
const tagPush = process.env.GITHUB_REF_TYPE === "tag";
const manualTagRetry = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  (!tagPush && !manualTagRetry) ||
  !tag
) {
  throw new Error(
    "Direct npm publishing is disabled. Create and push a version tag; publish.yml owns npm releases.",
  );
}

execFileSync(process.execPath, ["scripts/validate-release.mjs", "--tag", tag], {
  stdio: "inherit",
});
