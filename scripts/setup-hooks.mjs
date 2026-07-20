import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: root,
});
chmodSync(join(root, ".githooks", "pre-commit"), 0o755);
process.stdout.write("Git hooks enabled from .githooks.\n");
