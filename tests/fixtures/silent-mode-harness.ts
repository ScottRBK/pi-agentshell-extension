import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../../index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PYTHON_DIR = join(ROOT, "python");
const FAKE_BIN = join(PYTHON_DIR, "tests", "fixtures", "bin");

interface CommandContext {
  ui: {
    notify(message: string, type: string): void;
  };
}

interface CapturedCommand {
  name: string;
  description?: string;
  handler(args: string, context: CommandContext): Promise<void>;
}

interface CapturedEntry {
  customType: string;
  data: unknown;
}

interface CapturedResult {
  content: Array<{ type: string; text: string }>;
  details: {
    status: string;
    sessionId?: string;
    outputTokens: number;
    warnings: string[];
    silent?: boolean;
  };
}

interface CapturedComponent {
  render(width: number): string[];
}

interface CapturedTool {
  execute: (...args: any[]) => Promise<CapturedResult>;
  renderResult?: (
    result: CapturedResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: CapturedTheme,
    context: { isError: boolean },
  ) => CapturedComponent;
}

interface CapturedTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

interface SessionContext {
  sessionManager: {
    getBranch(): SessionEntry[];
  };
}

type SessionStartHandler = (
  event: { type: "session_start"; reason: "resume" },
  context: SessionContext,
) => Promise<void> | void;

async function withFakeCodex<T>(
  response: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousResponse = process.env.FAKE_CODEX_RESPONSE;
  process.env.PATH = FAKE_BIN;
  process.env.FAKE_CODEX_RESPONSE = response;

  try {
    return await operation();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    if (previousResponse === undefined) {
      delete process.env.FAKE_CODEX_RESPONSE;
    } else {
      process.env.FAKE_CODEX_RESPONSE = previousResponse;
    }
  }
}

export default async function silentModeHarness(): Promise<void> {
  const commands: CapturedCommand[] = [];
  const entries: CapturedEntry[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const tools: CapturedTool[] = [];

  const fakePi = {
    registerCommand(
      name: string,
      command: Omit<CapturedCommand, "name">,
    ) {
      commands.push({ name, ...command });
    },
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    on() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);

  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.ok(command);
  assert.equal(command.name, "agentshell-silent");
  assert.match(command.description ?? "", /subagent response/i);

  const context: CommandContext = {
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };

  await command.handler("", context);

  assert.deepEqual(entries, [
    {
      customType: "agentshell-output-mode",
      data: { silent: true },
    },
  ]);
  assert.deepEqual(notifications, [
    {
      message: "Subagent responses are now hidden.",
      type: "info",
    },
  ]);

  const tool = tools[0];
  assert.ok(tool);
  const updates: CapturedResult[] = [];
  const silentResult = await withFakeCodex(
    "hidden response",
    () => tool.execute(
      "silent-mode-call",
      {
        agent_type: "codex",
        allowed_tools: ["Read"],
        prompt: "Return a hidden response",
      },
      undefined,
      (update: CapturedResult) => updates.push(update),
      { cwd: PYTHON_DIR },
    ),
  );

  assert.deepEqual(updates, []);
  const warning =
    "Codex CLI has no per-call allowed_tools mechanism; ignoring";

  assert.deepEqual(silentResult.content, [
    {
      type: "text",
      text:
        `Warning: ${warning}\n\nhidden response` +
        "\n\nSession ID: test-session",
    },
  ]);
  assert.deepEqual(silentResult.details.warnings, [warning]);
  assert.equal(silentResult.details.silent, true);

  const renderResult = tool.renderResult;
  assert.ok(renderResult);
  const theme: CapturedTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  for (const expanded of [false, true]) {
    assert.deepEqual(
      renderResult(
        silentResult,
        { expanded, isPartial: false },
        theme,
        { isError: false },
      ).render(100).map((line) => line.trimEnd()),
      [`Warning: ${warning}`, "✓ Completed"],
    );
  }

  const errorResult: CapturedResult = {
    content: [{ type: "text", text: "AgentShell failed" }],
    details: {
      status: "error",
      outputTokens: 0,
      warnings: [],
      silent: true,
    },
  };
  assert.deepEqual(
    renderResult(
      errorResult,
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    ).render(100).map((line) => line.trimEnd()),
    ["AgentShell failed"],
  );

  await command.handler("", context);

  assert.deepEqual(entries[1], {
    customType: "agentshell-output-mode",
    data: { silent: false },
  });
  assert.deepEqual(notifications[1], {
    message: "Subagent responses are now visible.",
    type: "info",
  });

  const visibleUpdates: CapturedResult[] = [];
  const visibleResult = await withFakeCodex(
    "visible response",
    () => tool.execute(
      "visible-mode-call",
      {
        agent_type: "codex",
        prompt: "Return a visible response",
      },
      undefined,
      (update: CapturedResult) => visibleUpdates.push(update),
      { cwd: PYTHON_DIR },
    ),
  );

  assert.equal(visibleUpdates.length, 1);
  assert.equal(visibleResult.details.silent, undefined);
  assert.deepEqual(
    renderResult(
      visibleResult,
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    ).render(100).map((line) => line.trimEnd()),
    ["visible response", "", "Session ID: test-session"],
  );

  const restoredCommands: CapturedCommand[] = [];
  const restoredEntries: CapturedEntry[] = [];
  const restoredNotifications: Array<{
    message: string;
    type: string;
  }> = [];
  let sessionStart: SessionStartHandler | undefined;

  const restoredPi = {
    registerCommand(
      name: string,
      registered: Omit<CapturedCommand, "name">,
    ) {
      restoredCommands.push({ name, ...registered });
    },
    registerTool() {},
    on(event: string, handler: SessionStartHandler) {
      assert.equal(event, "session_start");
      sessionStart = handler;
    },
    appendEntry(customType: string, data: unknown) {
      restoredEntries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(restoredPi);
  assert.ok(sessionStart);

  await sessionStart(
    { type: "session_start", reason: "resume" },
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "agentshell-output-mode",
            data: { silent: true },
          },
        ],
      },
    },
  );

  const restoredCommand = restoredCommands[0];
  assert.ok(restoredCommand);
  await restoredCommand.handler("", {
    ui: {
      notify(message, type) {
        restoredNotifications.push({ message, type });
      },
    },
  });

  assert.deepEqual(restoredEntries, [
    {
      customType: "agentshell-output-mode",
      data: { silent: false },
    },
  ]);
  assert.deepEqual(restoredNotifications, [
    {
      message: "Subagent responses are now visible.",
      type: "info",
    },
  ]);

  process.stderr.write("SILENT_MODE_COMMAND_OK\n");
}
