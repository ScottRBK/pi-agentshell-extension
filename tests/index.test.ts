import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = join(ROOT, "tests", "fixtures", "index-harness.ts");

test("registers and executes the subagent tool", { timeout: 15_000 }, () => {
  const completed = spawnSync(
    "pi",
    [
      "--mode",
      "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--extension",
      HARNESS,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      input: '{"type":"get_state","id":"index-test"}\n',
      timeout: 10_000,
    },
  );

  assert.equal(
    completed.error,
    undefined,
    completed.error?.message,
  );
  assert.equal(
    completed.status,
    0,
    `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
  );
  assert.match(completed.stderr, /INDEX_HARNESS_OK/);
});
