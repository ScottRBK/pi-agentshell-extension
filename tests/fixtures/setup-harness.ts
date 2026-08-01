import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "./index.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PYTHON_PROJECT = join(ROOT, "python");
const RUNTIME_PYTHON = join(PYTHON_PROJECT, ".venv", "bin", "python");

type Scenario = "install" | "missing-uv" | "decline";
type NotificationType = "info" | "warning" | "error";

interface CapturedTool {
  name: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface SetupContext {
  hasUI: boolean;
  sessionManager: {
    getBranch(): [];
  };
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type: NotificationType): void;
  };
}

type SessionStartHandler = (
  event: { type: "session_start"; reason: "startup" },
  context: SetupContext,
) => Promise<void> | void;

interface ExecCall {
  command: string;
  args: string[];
}

function result(code: number, stderr = ""): ExecResult {
  return {
    stdout: code === 0 ? "uv 0.8.0\n" : "",
    stderr,
    code,
    killed: false,
  };
}

function installFakeRuntime(): void {
  const realPython = process.env.REAL_AGENT_SHELL_PYTHON;
  assert.ok(realPython, "REAL_AGENT_SHELL_PYTHON is required");
  assert.ok(!realPython.includes("'"), "test Python path cannot contain a quote");

  mkdirSync(dirname(RUNTIME_PYTHON), { recursive: true });
  writeFileSync(
    RUNTIME_PYTHON,
    `#!/bin/sh\nexec '${realPython}' "$@"\n`,
    "utf8",
  );
  chmodSync(RUNTIME_PYTHON, 0o755);
}

export default async function setupHarness(): Promise<void> {
  const scenario = process.env.SETUP_SCENARIO as Scenario | undefined;
  assert.ok(
    scenario === "install" ||
      scenario === "missing-uv" ||
      scenario === "decline",
    `unsupported setup scenario: ${scenario}`,
  );

  const tools: CapturedTool[] = [];
  const execCalls: ExecCall[] = [];
  const notifications: Array<{
    message: string;
    type: NotificationType;
  }> = [];
  let confirmCalls = 0;
  const sessionStarts: SessionStartHandler[] = [];

  const fakePi = {
    registerCommand() {},
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    registerMessageRenderer() {},
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") {
        sessionStarts.push(handler);
      }
    },
    appendEntry() {},
    async exec(command: string, args: string[]): Promise<ExecResult> {
      execCalls.push({ command, args });

      if (args[0] === "--version") {
        return scenario === "missing-uv"
          ? result(1, "uv was not found")
          : result(0);
      }

      assert.equal(scenario, "install");
      assert.equal(command, "uv");
      assert.deepEqual(args, [
        "sync",
        "--project",
        PYTHON_PROJECT,
        "--locked",
      ]);
      installFakeRuntime();
      return result(0);
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);

  assert.equal(tools.length, 0);
  assert.equal(sessionStarts.length, 2);

  const context: SetupContext = {
    hasUI: true,
    sessionManager: {
      getBranch: () => [],
    },
    ui: {
      async confirm(title, message) {
        confirmCalls += 1;
        assert.match(title, /AgentShell runtime/);
        assert.match(message, /uv sync .* --locked/);
        return scenario !== "decline";
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };

  for (const sessionStart of sessionStarts) {
    await sessionStart(
      { type: "session_start", reason: "startup" },
      context,
    );
  }

  if (scenario === "install") {
    assert.equal(confirmCalls, 1);
    assert.equal(execCalls.length, 2);
    assert.equal(tools.length, 2);
    assert.ok(tools.some(({ name }) => name === "subagent"));
    assert.ok(tools.some(({ name }) => name === "subagent_cancel"));
    assert.ok(notifications.some(({ message }) => /ready/.test(message)));
  } else if (scenario === "missing-uv") {
    assert.equal(confirmCalls, 0);
    assert.equal(execCalls.length, 1);
    assert.equal(tools.length, 0);
    assert.ok(
      notifications.some(({ message, type }) =>
        type === "error" && message.includes("docs.astral.sh/uv")
      ),
    );
  } else {
    assert.equal(confirmCalls, 1);
    assert.equal(execCalls.length, 1);
    assert.equal(tools.length, 0);
    assert.ok(
      notifications.some(({ message, type }) =>
        type === "warning" && message.includes("uv sync")
      ),
    );
  }

  process.stderr.write(`SETUP_HARNESS_OK:${scenario}\n`);
}
