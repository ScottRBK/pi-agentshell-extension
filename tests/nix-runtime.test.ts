import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const RUNNER = fileURLToPath(new URL("../runner.ts", import.meta.url));

/**
 * A developer's own shell may already export these, which would silently change
 * what the "no override" cases measure.
 */
function scrubRuntimeEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.PI_AGENT_SHELL_PYTHON;
  delete base.PI_AGENT_SHELL_RUNTIME_DIR;
  delete base.UV_PROJECT_ENVIRONMENT;
  return { ...base, ...env };
}

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
    { env: scrubRuntimeEnv(env), encoding: "utf8", timeout: 20_000 },
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

interface ProbeResult {
  installed: boolean;
  version: string | null;
}

function probeInterpreter(script: string): ProbeResult {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "pi-nix-probe-"));
  const interpreter = join(directory, "python");

  try {
    writeFileSync(interpreter, script, "utf8");
    chmodSync(interpreter, 0o755);

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", [
        `import { isAgentShellRuntimeInstalled, agentShellRuntimeVersion } from ${JSON.stringify(RUNNER)};`,
        "console.log(JSON.stringify({",
        "  installed: isAgentShellRuntimeInstalled(),",
        "  version: agentShellRuntimeVersion(),",
        "}));",
      ].join(" ")],
      {
        env: { ...process.env, PI_AGENT_SHELL_PYTHON: interpreter },
        encoding: "utf8",
        timeout: 20_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("an interpreter that cannot import agent_shell is not a runtime", () => {
  // Act: executable, so a file-exists check would have accepted it.
  const probe = probeInterpreter("#!/bin/sh\nexit 1\n");

  // Assert
  assert.equal(probe.installed, false);
  assert.equal(probe.version, null);
});

test("the probe reports the agent_shell version the interpreter provides", () => {
  // Act
  const probe = probeInterpreter("#!/bin/sh\necho 0.5.0\nexit 0\n");

  // Assert
  assert.equal(probe.installed, true);
  assert.equal(probe.version, "0.5.0");
});

/** Reads the blocker from a copy of the extension, so its directory can be made read-only. */
function blockerFromLayout(
  layout: "writable" | "read-only",
  env: Record<string, string> = {},
): string[] | null {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "pi-nix-blocker-"));

  try {
    for (const file of ["runner.ts", "limits.ts"]) {
      copyFileSync(
        join(dirname(RUNNER), file),
        join(directory, file),
      );
    }

    // The blocker checks the install directory, which must exist to be
    // writable.
    mkdirSync(join(directory, "python"), { recursive: true });

    if (layout === "read-only") {
      chmodSync(join(directory, "python"), 0o555);
      chmodSync(directory, 0o555);
    }

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", [
        `import { agentShellSetupBlocker } from ${JSON.stringify(join(directory, "runner.ts"))};`,
        "console.log(JSON.stringify(agentShellSetupBlocker()));",
      ].join(" ")],
      { env: scrubRuntimeEnv(env), encoding: "utf8", timeout: 20_000 },
    );

    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    chmodSync(directory, 0o755);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("setup is offered when the install directory is writable", () => {
  // Act
  const blocker = blockerFromLayout("writable");

  // Assert
  assert.equal(blocker, null);
});

test("a read-only install names the variables that fix it", () => {
  // Act
  const blocker = blockerFromLayout("read-only") ?? [];

  // Assert
  assert.match(blocker.join(" "), /read-only/);
  assert.match(blocker.join(" "), /PI_AGENT_SHELL_PYTHON/);
  assert.match(blocker.join(" "), /PI_AGENT_SHELL_RUNTIME_DIR/);
  assert.doesNotMatch(blocker.join(" "), /uv/);
});

test("an injected interpreter that cannot import names itself", () => {
  // Act
  const blocker = blockerFromLayout("writable", {
    PI_AGENT_SHELL_PYTHON: join(tmpdir(), "nix-store", "bin", "python"),
  }) ?? [];

  // Assert
  assert.match(blocker.join(" "), /PI_AGENT_SHELL_PYTHON/);
});

test("a working injected interpreter raises no blocker", () => {
  // Arrange: an interpreter that imports agent_shell, next to a read-only
  // install - the normal Nix case.
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "pi-nix-good-"));
  const interpreter = join(directory, "python");

  try {
    writeFileSync(interpreter, "#!/bin/sh\necho 0.5.0\nexit 0\n", "utf8");
    chmodSync(interpreter, 0o755);

    // Act
    const blocker = blockerFromLayout("read-only", {
      PI_AGENT_SHELL_PYTHON: interpreter,
    });

    // Assert: setup is not offered, and no failure is invented.
    assert.equal(blocker, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
