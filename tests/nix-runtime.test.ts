import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const RUNNER = fileURLToPath(new URL("../runner.ts", import.meta.url));

interface RuntimeLayout {
  projectDirectory: string;
  venvDirectory: string;
  injected: boolean;
  setupCommand: string;
  uvProjectEnvironment: string;
}

/**
 * The runtime layout is resolved once at module load, so every case needs its
 * own process.
 */
function inspectLayout(env: Record<string, string>): RuntimeLayout {
  const script = [
    `import { AGENT_SHELL_PROJECT_DIRECTORY, AGENT_SHELL_VENV_DIRECTORY,`,
    `  agentShellRuntimeIsInjected, agentShellSetupCommand } from ${JSON.stringify(RUNNER)};`,
    "console.log(JSON.stringify({",
    "  projectDirectory: AGENT_SHELL_PROJECT_DIRECTORY,",
    "  venvDirectory: AGENT_SHELL_VENV_DIRECTORY,",
    "  injected: agentShellRuntimeIsInjected(),",
    "  setupCommand: agentShellSetupCommand(),",
    "  uvProjectEnvironment: process.env.UV_PROJECT_ENVIRONMENT || '',",
    "}));",
  ].join(" ");

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 },
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("no override keeps the virtualenv beside the extension", () => {
  // Act
  const layout = inspectLayout({});

  // Assert
  assert.equal(layout.injected, false);
  assert.equal(
    layout.venvDirectory,
    join(layout.projectDirectory, ".venv"),
  );
  assert.equal(layout.uvProjectEnvironment, "");
  assert.equal(
    layout.setupCommand,
    `uv sync --project "${layout.projectDirectory}" --locked --no-build`,
  );
});

test("PI_AGENT_SHELL_PYTHON marks the runtime as supplied from outside", () => {
  // Act
  const layout = inspectLayout({
    PI_AGENT_SHELL_PYTHON: join(tmpdir(), "nix-store", "bin", "python"),
  });

  // Assert: setup is never offered for an injected interpreter.
  assert.equal(layout.injected, true);
});

test("PI_AGENT_SHELL_RUNTIME_DIR relocates the virtualenv uv creates", () => {
  // Arrange
  const relocated = join(realpathSync(tmpdir()), "pi-agent-shell-venv");

  // Act
  const layout = inspectLayout({ PI_AGENT_SHELL_RUNTIME_DIR: relocated });

  // Assert: uv is told where to build, and the printed command matches.
  assert.equal(layout.venvDirectory, relocated);
  assert.equal(layout.uvProjectEnvironment, relocated);
  assert.equal(
    layout.setupCommand,
    `UV_PROJECT_ENVIRONMENT="${relocated}" ` +
      `uv sync --project "${layout.projectDirectory}" --locked --no-build`,
  );
  assert.notEqual(layout.venvDirectory, join(layout.projectDirectory, ".venv"));
});
