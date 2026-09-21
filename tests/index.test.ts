import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
const INTERACTIVE_HARNESS = join(
  ROOT,
  "tests",
  "fixtures",
  "interactive-index-harness.ts",
);
const ROSTER_HARNESS = join(ROOT, "tests", "fixtures", "roster-harness.ts");

test("toggles the global roster tool and invocation hint", { timeout: 15_000 }, () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-agent-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDirectory };
  delete env.PI_AGENT_SHELL_CHILD;

  try {
    mkdirSync(join(agentDirectory, "extensions"));
    writeFileSync(
      join(agentDirectory, "extensions", "agentshell.json"),
      JSON.stringify({ roster: { roles: [{
        name: "reviewer",
        description: "Review code for defects",
        agent_type: "codex",
        model: "gpt-5",
        effort: "high",
      }] } }),
      "utf8",
    );
    const completed = spawnSync(
      "pi",
      ["--mode", "rpc", "--offline", "--no-session", "--no-extensions",
        "--extension", ROSTER_HARNESS],
      {
        cwd: ROOT,
        encoding: "utf8",
        env,
        input: '{"type":"get_state","id":"roster-test"}\n',
        timeout: 10_000,
      },
    );

    assert.equal(
      completed.status,
      0,
      `error: ${completed.error?.message}\n` +
        `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
    );
    assert.match(completed.stderr, /ROSTER_HARNESS_OK/);
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

function runInteractiveIndexHarness(oldRuntime = false): ReturnType<typeof spawnSync> {
  const temporaryExtension = mkdtempSync(
    join(tmpdir(), "pi-agentshell-interactive-index-"),
  );
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-interactive-agent-"),
  );
  const pythonDirectory = join(
    temporaryExtension,
    "python",
    ".venv",
    "bin",
  );
  const requestFile = join(temporaryExtension, "request");
  const closedFile = join(temporaryExtension, "closed");
  const cwd = join(temporaryExtension, "cwd");

  mkdirSync(join(agentDirectory, "extensions"));
  writeFileSync(
    join(agentDirectory, "extensions", "agentshell.json"),
    JSON.stringify({
      interactive: {
        enabled: true,
        stay_open: true,
        inactivity_timeout: 15.5,
        inactivity_enabled: false,
      },
    }),
    "utf8",
  );
  mkdirSync(pythonDirectory, { recursive: true });
  mkdirSync(cwd);
  for (const file of ["index.ts", "runner.ts", "config.ts", "limits.ts", "jobs.ts"]) {
    copyFileSync(join(ROOT, file), join(temporaryExtension, file));
  }
  copyFileSync(INTERACTIVE_HARNESS, join(temporaryExtension, "interactive-index-harness.ts"));
  const fakePython = join(pythonDirectory, "python");
  writeFileSync(
    fakePython,
    "#!/bin/sh\n" +
      "if [ \"$2\" = \"-c\" ]; then\n" +
      (oldRuntime ? "  exit 1\n" : "  exit 0\n") +
      "fi\n" +
      "trap '' INT TERM\n" +
      "IFS= read -r request || [ -n \"$request\" ] || exit 1\n" +
      "case \"$request\" in\n" +
      "  *'\"operation\":\"list_agent_types\"'*)\n" +
      "    printf '%s\\n' '{\"kind\":\"agent_types\",\"agent_types\":[\"codex\"]}'\n" +
      "    exit 0\n" +
      "    ;;\n" +
      "esac\n" +
      ": > \"$FAKE_INTERACTIVE_REQUEST_FILE\"\n" +
      "printf '%s\\n' \"$request\" > \"$FAKE_INTERACTIVE_REQUEST_FILE\"\n" +
      "if printf '%s' \"$request\" | grep -q '\"interactive\":true'; then\n" +
      "  printf '%s\\n' '{\"kind\":\"event\",\"event\":{\"type\":\"text\"," +
        "\"content\":\"interactive response\"}}'\n" +
      "  printf '%s\\n' '{\"kind\":\"event\",\"event\":{\"type\":\"result\"," +
        "\"content\":\"ok\"}}'\n" +
      "  printf '%s\\n' '{\"kind\":\"complete\"}'\n" +
      "  while IFS= read -r _line; do :; done\n" +
      "  : > \"$FAKE_INTERACTIVE_CLOSED_FILE\"\n" +
      "else\n" +
      "  printf '%s\\n' '{\"kind\":\"event\",\"event\":{\"type\":\"text\"," +
        "\"content\":\"headless response\"}}'\n" +
      "  printf '%s\\n' '{\"kind\":\"event\",\"event\":{\"type\":\"result\"," +
        "\"content\":\"ok\"}}'\n" +
      "fi\n",
    "utf8",
  );
  chmodSync(fakePython, 0o755);

  try {
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      FAKE_INTERACTIVE_REQUEST_FILE: requestFile,
      FAKE_INTERACTIVE_CLOSED_FILE: closedFile,
      FAKE_INTERACTIVE_CWD: cwd,
      ...(oldRuntime ? { FAKE_INTERACTIVE_OLD_RUNTIME: "1" } : {}),
      TMUX: oldRuntime ? "" : "tmux-test",
      TMUX_PANE: oldRuntime ? "" : "%1",
    };
    delete env.PI_AGENT_SHELL_CHILD;

    return spawnSync(
      "pi",
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--no-extensions",
        "--extension",
        join(temporaryExtension, "interactive-index-harness.ts"),
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env,
        input: '{"type":"get_state","id":"interactive-index-test"}\n',
        timeout: 10_000,
      },
    );
  } finally {
    rmSync(temporaryExtension, { recursive: true, force: true });
    rmSync(agentDirectory, { recursive: true, force: true });
  }
}

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

test("defers active-agent completions until settlement", {
  timeout: 15_000,
}, () => {
  const env = {
    ...process.env,
    INDEX_DELIVERY_RACE_TEST: "1",
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
      HARNESS,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env,
      input: '{"type":"get_state","id":"index-delivery-race-test"}\n',
      timeout: 10_000,
    },
  );

  assert.equal(completed.error, undefined, completed.error?.message);
  assert.equal(
    completed.status,
    0,
    `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
  );
  assert.match(completed.stderr, /INDEX_DELIVERY_RACE_HARNESS_OK/);
});

test("keeps the parent active after a non-idle settlement", {
  timeout: 15_000,
}, () => {
  const env = {
    ...process.env,
    INDEX_DELIVERY_IDLE_CHECK_TEST: "1",
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
      HARNESS,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env,
      input: '{"type":"get_state","id":"index-delivery-idle-check-test"}\n',
      timeout: 10_000,
    },
  );

  assert.equal(completed.error, undefined, completed.error?.message);
  assert.equal(
    completed.status,
    0,
    `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
  );
  assert.match(completed.stderr, /INDEX_DELIVERY_IDLE_CHECK_HARNESS_OK/);
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

test("wires interactive config, overrides, and shutdown cleanup through the Pi tool", {
  timeout: 15_000,
}, () => {
  const completed = runInteractiveIndexHarness();

  assert.equal(completed.error, undefined, completed.error?.message);
  assert.equal(
    completed.status,
    0,
    `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
  );
  assert.match(completed.stderr, /INTERACTIVE_INDEX_HARNESS_OK/);
});

test("rejects interactive launches on an old runtime while keeping headless calls working", {
  timeout: 15_000,
}, () => {
  const completed = runInteractiveIndexHarness(true);

  assert.equal(completed.error, undefined, completed.error?.message);
  assert.equal(
    completed.status,
    0,
    `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
  );
  assert.match(completed.stderr, /INTERACTIVE_INDEX_OLD_RUNTIME_HARNESS_OK/);
});
