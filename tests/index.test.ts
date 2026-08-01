import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = join(ROOT, "tests", "fixtures", "index-harness.ts");

test("submits subagent jobs and delivers their completions", {
  timeout: 15_000,
}, () => {
  const env = { ...process.env };
  delete env.PI_AGENT_SHELL_CHILD;

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
      env,
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

test("applies user-configured AgentShell limits", {
  timeout: 15_000,
}, () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-index-limits-"),
  );
  const extensionDirectory = join(agentDirectory, "extensions");
  const env = {
    ...process.env,
    INDEX_LIMIT_TEST: "1",
    PI_CODING_AGENT_DIR: agentDirectory,
  };
  delete env.PI_AGENT_SHELL_CHILD;

  try {
    mkdirSync(extensionDirectory);
    writeFileSync(
      join(extensionDirectory, "agentshell.json"),
      JSON.stringify({ maxOutputBytes: 5 }),
      "utf8",
    );

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
        env,
        input: '{"type":"get_state","id":"index-limit-test"}\n',
        timeout: 10_000,
      },
    );

    assert.equal(completed.error, undefined, completed.error?.message);
    assert.equal(
      completed.status,
      0,
      `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
    );
    assert.match(completed.stderr, /INDEX_LIMIT_HARNESS_OK/);
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});
