import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = join(ROOT, "tests", "fixtures", "package-harness.ts");

const EXPECTED_PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "config.ts",
  "docs/assets/architecture.png",
  "extensions/agentshell.ts",
  "index.ts",
  "limits.ts",
  "package.json",
  "python/pyproject.toml",
  "python/uv.lock",
  "python/worker.py",
  "runner.ts",
];

test("packs the complete AgentShell runtime for npm", () => {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  assert.equal(packed.error, undefined, packed.error?.message);
  assert.equal(
    packed.status,
    0,
    `stdout:\n${packed.stdout}\nstderr:\n${packed.stderr}`,
  );

  const [manifest] = JSON.parse(packed.stdout) as Array<{
    name: string;
    version: string;
    files: Array<{ path: string }>;
  }>;
  assert.ok(manifest);
  assert.equal(manifest.name, "@scottrbk/pi-agentshell-extension");
  assert.equal(manifest.version, "1.0.2");

  const files = manifest.files.map(({ path }) => path).sort();
  assert.deepEqual(files, EXPECTED_PACKAGE_FILES);
});

test("loads the extension when installed as a Pi package", {
  timeout: 15_000,
}, () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-package-"),
  );
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
  };
  delete env.PI_AGENT_SHELL_CHILD;

  try {
    const installed = spawnSync(
      "pi",
      ["install", ROOT],
      {
        cwd: ROOT,
        encoding: "utf8",
        env,
        timeout: 10_000,
      },
    );

    assert.equal(installed.error, undefined, installed.error?.message);
    assert.equal(
      installed.status,
      0,
      `stdout:\n${installed.stdout}\nstderr:\n${installed.stderr}`,
    );

    const loaded = spawnSync(
      "pi",
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--extension",
        HARNESS,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env,
        input: '{"type":"get_state","id":"package-test"}\n',
        timeout: 10_000,
      },
    );

    assert.equal(loaded.error, undefined, loaded.error?.message);
    assert.equal(
      loaded.status,
      0,
      `stdout:\n${loaded.stdout}\nstderr:\n${loaded.stderr}`,
    );
    assert.match(loaded.stderr, /PACKAGE_HARNESS_OK/);
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});
