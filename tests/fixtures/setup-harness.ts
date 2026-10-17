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

type Scenario = "install" | "missing-uv" | "decline" | "outdated" | "resources-outdated";
type NotificationType = "info" | "warning" | "error";

interface CapturedTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface SetupContext {
  cwd: string;
  mode: "json";
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

function installFakeRuntime(outdated = false, resourcesOutdated = false): void {
  const realPython = process.env.REAL_AGENT_SHELL_PYTHON;
  assert.ok(realPython, "REAL_AGENT_SHELL_PYTHON is required");
  assert.ok(!realPython.includes("'"), "test Python path cannot contain a quote");

  mkdirSync(dirname(RUNTIME_PYTHON), { recursive: true });
  const capabilityCheck = outdated
    ? "if [ \"$2\" = \"-c\" ]; then exit 1; fi\n"
    : "";

  // Double only the worker process response from a runtime without the 0.5 resources API.
  const resourceCheck = resourcesOutdated
    ? 'if [ "$2" != "-c" ]; then\n'
      + '  IFS= read -r request || [ -n "$request" ] || exit 1\n'
      + '  case "$request" in *\'"resources":\'*)\n'
      + "    printf '%s\\n' '{\"kind\":\"fatal\",\"message\":"
      + '"Session resources require AgentShell 0.5.0; update the runtime"}\'\n'
      + '    exit 1;; esac\n'
      + `  printf '%s\\n' "$request" | '${realPython}' "$@"; exit $?\nfi\n`
    : "";
  writeFileSync(
    RUNTIME_PYTHON,
    `#!/bin/sh\n${capabilityCheck}${resourceCheck}exec '${realPython}' "$@"\n`,
    "utf8",
  );
  chmodSync(RUNTIME_PYTHON, 0o755);
}

export default async function setupHarness(): Promise<void> {
  const scenario = process.env.SETUP_SCENARIO as Scenario | undefined;
  assert.ok(
    scenario === "install" ||
      scenario === "missing-uv" ||
      scenario === "decline" ||
      scenario === "outdated" || scenario === "resources-outdated",
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
        "--no-build",
      ]);
      installFakeRuntime();
      return result(0);
    },
  } as unknown as ExtensionAPI;

  if (scenario === "outdated" || scenario === "resources-outdated") {
    installFakeRuntime(scenario === "outdated", scenario === "resources-outdated");
  }

  await subagentsExtension(fakePi);

  assert.equal(tools.length,
    scenario === "outdated" ? 3 : scenario === "resources-outdated" ? 4 : 0);
  assert.equal(sessionStarts.length, scenario === "resources-outdated" ? 1 : 2);

  const context: SetupContext = {
    cwd: ROOT,
    mode: "json",
    hasUI: true,
    sessionManager: {
      getBranch: () => [],
    },
    ui: {
      async confirm(title, message) {
        confirmCalls += 1;
        assert.match(title, /AgentShell runtime/);
        assert.match(message, /uv sync .* --locked --no-build/);
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

  if (scenario === "resources-outdated") {
    const tool = tools.find(({ name }) => name === "subagent")!;
    // Act / Assert: recovery is actionable but always requires the user's consent.
    await assert.rejects(tool.execute("old-resources", { agent_type: "pi",
      task_name: "Resource selection", prompt: "Must not launch", resources: {},
    }, undefined, undefined, context), (error: Error) => {
      assert.match(error.message, /AgentShell 0\.5\.0/);
      assert.ok(error.message.includes(
        `uv sync --project "${PYTHON_PROJECT}" --locked --no-build`), error.message);
      assert.match(error.message, /reload/i);
      return true;
    });
    assert.equal(confirmCalls, 0);
    assert.equal(execCalls.length, 0);
  } else if (scenario === "install") {
    assert.equal(confirmCalls, 1);
    assert.equal(execCalls.length, 2);
    assert.equal(tools.length, 4);
    assert.ok(tools.some(({ name }) => name === "subagent"));
    assert.ok(tools.some(({ name }) => name === "subagent_list_models"));
    assert.ok(tools.some(({ name }) => name === "subagent_status"));
    assert.ok(tools.some(({ name }) => name === "subagent_cancel"));
    assert.ok(notifications.some(({ message }) => /ready/.test(message)));
  } else if (scenario === "outdated") {
    assert.equal(confirmCalls, 0);
    assert.equal(execCalls.length, 0);
    assert.ok(tools.some(({ name }) => name === "subagent"));
    assert.ok(tools.some(({ name }) => name === "subagent_status"));
    assert.ok(tools.some(({ name }) => name === "subagent_cancel"));
    assert.ok(!tools.some(({ name }) => name === "subagent_list_models"));
    assert.ok(
      notifications.some(({ message, type }) =>
        type === "warning" && /model discovery needs/i.test(message)
      ),
    );
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
