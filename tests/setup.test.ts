import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REAL_PYTHON = join(ROOT, "python", ".venv", "bin", "python");
const SETUP_HARNESS = join(ROOT, "tests", "fixtures", "setup-harness.ts");

const scenarios = [
  ["installs the missing AgentShell runtime after confirmation", "install"],
  ["explains how to install uv when uv is missing", "missing-uv"],
  ["leaves the AgentShell runtime uninstalled when declined", "decline"],
] as const;

for (const [name, scenario] of scenarios) {
  test(name, { timeout: 15_000 }, () => {
    const temporaryExtension = mkdtempSync(
      join(tmpdir(), "pi-subagents-setup-"),
    );

    try {
      const temporaryPython = join(temporaryExtension, "python");
      mkdirSync(temporaryPython);

      copyFileSync(
        join(ROOT, "index.ts"),
        join(temporaryExtension, "index.ts"),
      );
      copyFileSync(
        join(ROOT, "runner.ts"),
        join(temporaryExtension, "runner.ts"),
      );
      copyFileSync(
        join(ROOT, "config.ts"),
        join(temporaryExtension, "config.ts"),
      );
      copyFileSync(
        join(ROOT, "limits.ts"),
        join(temporaryExtension, "limits.ts"),
      );
      copyFileSync(
        join(ROOT, "python", "worker.py"),
        join(temporaryPython, "worker.py"),
      );
      copyFileSync(
        join(ROOT, "python", "pyproject.toml"),
        join(temporaryPython, "pyproject.toml"),
      );
      copyFileSync(
        join(ROOT, "python", "uv.lock"),
        join(temporaryPython, "uv.lock"),
      );
      copyFileSync(
        SETUP_HARNESS,
        join(temporaryExtension, "setup-harness.ts"),
      );

      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: join(temporaryExtension, "agent"),
        REAL_AGENT_SHELL_PYTHON: REAL_PYTHON,
        SETUP_SCENARIO: scenario,
      };
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
          join(temporaryExtension, "setup-harness.ts"),
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          env,
          input: '{"type":"get_state","id":"setup-test"}\n',
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
      assert.match(
        completed.stderr,
        new RegExp(`SETUP_HARNESS_OK:${scenario}`),
      );
    } finally {
      rmSync(temporaryExtension, { recursive: true, force: true });
    }
  });
}
