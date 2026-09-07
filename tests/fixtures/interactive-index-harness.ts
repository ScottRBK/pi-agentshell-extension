import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import subagentsExtension from "./index.ts";

interface CapturedTool {
  name: string;
  parameters: {
    properties?: Record<string, Record<string, unknown>>;
  };
  execute: (...args: any[]) => Promise<any>;
}

interface HarnessContext {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  ui: {
    theme: {
      bold(text: string): string;
      fg(color: string, text: string): string;
    };
    notify(message: string, type: string): void;
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: string },
    ): void;
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }

    await delay(10);
  }
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }

    await delay(10);
  }
}

function requestFromFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export default async function interactiveIndexHarness(): Promise<void> {
  const requestFile = process.env.FAKE_INTERACTIVE_REQUEST_FILE;
  const closedFile = process.env.FAKE_INTERACTIVE_CLOSED_FILE;
  const cwd = process.env.FAKE_INTERACTIVE_CWD;
  const oldRuntime = process.env.FAKE_INTERACTIVE_OLD_RUNTIME === "1";
  assert.ok(requestFile, "FAKE_INTERACTIVE_REQUEST_FILE is required");
  assert.ok(closedFile, "FAKE_INTERACTIVE_CLOSED_FILE is required");
  assert.ok(cwd, "FAKE_INTERACTIVE_CWD is required");

  const tools: CapturedTool[] = [];
  const shutdownHandlers: Array<(event: unknown, context: unknown) => Promise<void> | void> = [];
  const sessionStartHandlers: Array<
    (event: unknown, context: unknown) => Promise<void> | void
  > = [];
  const sentMessages: unknown[] = [];

  const fakePi = {
    registerCommand() {},
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    registerMessageRenderer() {},
    on(
      event: string,
      handler: (event: unknown, context: unknown) => Promise<void> | void,
    ) {
      if (event === "session_shutdown") {
        shutdownHandlers.push(handler);
      } else if (event === "session_start") {
        sessionStartHandlers.push(handler);
      }
    },
    appendEntry() {},
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
  };

  await subagentsExtension(fakePi as any);

  const tool = tools.find(({ name }) => name === "subagent");
  assert.ok(tool, "the subagent tool must be registered");
  assert.equal(shutdownHandlers.length, 1);
  assert.equal(
    tool.parameters.properties?.interactive?.type,
    "boolean",
  );
  assert.equal(
    tool.parameters.properties?.stay_open?.type,
    "boolean",
  );
  assert.equal(
    tool.parameters.properties?.inactivity_timeout?.exclusiveMinimum,
    0,
  );
  assert.equal(
    tool.parameters.properties?.inactivity_enabled?.type,
    "boolean",
  );

  const context: HarnessContext = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: {
        bold: (text) => text,
        fg: (_color, text) => text,
      },
      notify() {},
      setWidget() {},
    },
  };

  if (oldRuntime) {
    await assert.rejects(
      tool.execute(
        "interactive-index-old-runtime",
        {
          agent_type: "codex",
          task_name: "Needs interactive runtime",
          prompt: "This must be rejected before launch",
        },
        undefined,
        undefined,
        context,
      ),
      /updated runtime/i,
    );
  } else {
    const configuredResult = await tool.execute(
      "interactive-index-configured",
      {
        agent_type: "codex",
        task_name: "Configured interactive",
        prompt: "Use the configured native pane",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(configuredResult.details.status, "running");
    await waitForFile(requestFile);
    assert.deepEqual(requestFromFile(requestFile), {
      agent_type: "codex",
      cwd,
      prompt: "Use the configured native pane",
      interactive: true,
      stay_open: true,
      inactivity_timeout: 15.5,
      inactivity_enabled: false,
    });
    await waitFor(
      () => sentMessages.length === 1,
      "the configured interactive completion",
    );
    assert.equal(existsSync(closedFile), false);

    await shutdownHandlers[0]?.(
      { type: "session_shutdown" },
      context,
    );
    await waitForFile(closedFile);
    sentMessages.length = 0;
    rmSync(requestFile, { force: true });

    await sessionStartHandlers[0]?.(
      { type: "session_start" },
      { sessionManager: { getBranch: () => [] } },
    );
  }

  // An explicit headless launch must override an enabled interactive config and remain usable
  // when tmux is unavailable or the installed runtime predates interactive support.
  const headlessResult = await tool.execute(
    "interactive-index-headless",
    {
      agent_type: "codex",
      task_name: "Explicit headless",
      prompt: "Stay headless",
      interactive: false,
      stay_open: true,
      inactivity_timeout: 2.25,
      inactivity_enabled: true,
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(headlessResult.details.status, "running");
  await waitForFile(requestFile);
  assert.deepEqual(requestFromFile(requestFile), {
    agent_type: "codex",
    cwd,
    prompt: "Stay headless",
    interactive: false,
    stay_open: false,
    inactivity_timeout: 2.25,
    inactivity_enabled: true,
  });
  await waitFor(
    () => sentMessages.length === 1,
    "the explicit headless completion",
  );

  process.stderr.write(
    oldRuntime
      ? "INTERACTIVE_INDEX_OLD_RUNTIME_HARNESS_OK\n"
      : "INTERACTIVE_INDEX_HARNESS_OK\n",
  );
}
