import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  "docs/session-rosters.md",
  "extensions/agentshell.ts",
  "index.ts",
  "jobs.ts",
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
  assert.equal(manifest.version, "1.5.0");

  const files = manifest.files.map(({ path }) => path).sort();
  assert.deepEqual(files, EXPECTED_PACKAGE_FILES);
});

test("default test command excludes installation checks", { timeout: 20_000 }, () => {
  assert.equal(process.env.PACKAGE_INSTALL_ATTEMPT, undefined,
    "nested package check must select only install-labelled tests");
  // Arrange: refuse and record every Pi invocation; an installer can never run here.
  const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-test-command-"));
  const bin = join(directory, "bin");
  const attempt = join(directory, "pi-called");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$PACKAGE_INSTALL_ATTEMPT"\nexit 93\n',
    { mode: 0o755 });
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    HOME: directory,
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    npm_config_cache: join(directory, "npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    PACKAGE_INSTALL_ATTEMPT: attempt,
    NODE_OPTIONS: "--test-name-pattern=^install:",
  };

  try {
    // Act: even an explicit name match must not bypass the ordinary command's exclusion.
    const result = spawnSync("npm", ["test"], {
      cwd: ROOT, encoding: "utf8", env, timeout: 15_000,
    });

    // Assert: the real-install test never reached even the rejecting fake Pi.
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(existsSync(attempt), false, "ordinary npm test invoked the install check");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loads the packed runtime through Pi without installation", { timeout: 30_000 }, () => {
  // Arrange: a real archive and an empty, private Pi home; no account or source-tree fallback.
  const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-packed-"));
  const home = join(directory, "home");
  const cwd = join(directory, "workspace");
  const agentDirectory = join(home, ".pi", "agent");
  const extracted = join(directory, "extracted");
  for (const path of [agentDirectory, cwd, extracted]) mkdirSync(path, { recursive: true });
  const packageRoot = join(extracted, "package");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDirectory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_STATE_HOME: join(directory, "state"),
    XDG_CACHE_HOME: join(directory, "cache"),
    npm_config_cache: join(directory, "npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    PACKAGE_EXPECTED_ROOT: packageRoot,
  };
  const load = () => spawnSync("pi", [
    "--mode", "rpc", "--offline", "--no-session",
  ], {
    cwd, encoding: "utf8", env, timeout: 10_000,
    input: '{"type":"get_state","id":"packed-package-test"}\n',
  });

  try {
    const packed = spawnSync("npm", [
      "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", directory,
    ], { cwd: ROOT, encoding: "utf8", env, timeout: 10_000 });
    assert.equal(packed.error, undefined, packed.error?.message);
    assert.equal(packed.status, 0, packed.stderr);
    const [manifest] = JSON.parse(packed.stdout);
    assert.deepEqual(manifest.files.map(({ path }: { path: string }) => path).sort(),
      EXPECTED_PACKAGE_FILES);
    const unpacked = spawnSync("tar", [
      "-xzf", join(directory, manifest.filename), "-C", extracted,
    ], { cwd, encoding: "utf8", env, timeout: 5_000 });
    assert.equal(unpacked.error, undefined, unpacked.error?.message);
    assert.equal(unpacked.status, 0, unpacked.stderr);
    // Simulate completed runtime setup with the already installed, locked SDK; install nothing.
    symlinkSync(join(ROOT, "python", ".venv"), join(packageRoot, "python", ".venv"), "dir");
    writeFileSync(join(agentDirectory, "settings.json"),
      JSON.stringify({ packages: [packageRoot, HARNESS] }));

    // Act: Pi discovers the archive's manifest and extension through its local-package loader.
    const loaded = load();

    // Assert: real public tools came from the archive, and a missing runtime file breaks loading.
    assert.equal(loaded.error, undefined, loaded.error?.message);
    assert.equal(loaded.status, 0, `stdout:\n${loaded.stdout}\nstderr:\n${loaded.stderr}`);
    assert.match(loaded.stderr, /PACKAGE_HARNESS_OK/,
      `stdout:\n${loaded.stdout}\nstderr:\n${loaded.stderr}`);
    rmSync(join(packageRoot, "config.ts"));
    const broken = load();
    assert.equal(broken.error, undefined, broken.error?.message);
    assert.doesNotMatch(broken.stderr, /PACKAGE_HARNESS_OK/);
    assert.match(broken.stderr, /config\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install: loads the extension when installed as a Pi package", {
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
  delete env.PI_AGENT_SHELL_DEPTH;
  delete env.PI_AGENT_SHELL_MAX_DEPTH;

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
