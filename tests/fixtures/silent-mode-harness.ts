import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

interface CapturedMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: {
    status?: string;
    silent?: boolean;
    warnings?: string[];
  };
}

interface SentMessage {
  message: CapturedMessage;
  options?: {
    triggerTurn?: boolean;
    deliverAs?: string;
  };
}

interface CapturedResult {
  content: Array<{ type: string; text: string }>;
  details: {
    status: string;
    jobId?: string;
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

type MessageRenderer = (
  message: CapturedMessage,
  options: { expanded: boolean; outputPad: number },
  theme: CapturedTheme,
) => CapturedComponent | undefined;

interface CapturedMessageRenderer {
  customType: string;
  renderer: MessageRenderer;
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

function assertRunningJob(result: CapturedResult): void {
  assert.equal(result.details.status, "running");
  assert.match(
    result.details.jobId ?? "",
    /^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    result.content[0]?.text,
    `Subagent job ${result.details.jobId} started.`,
  );
}

export default async function silentModeHarness(): Promise<void> {
  const commands: CapturedCommand[] = [];
  const entries: CapturedEntry[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const messageRenderers: CapturedMessageRenderer[] = [];
  const sentMessages: SentMessage[] = [];
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
    registerMessageRenderer(customType: string, renderer: MessageRenderer) {
      messageRenderers.push({ customType, renderer });
    },
    on() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: CapturedMessage, options: SentMessage["options"]) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);

  assert.equal(
    commands.length,
    3,
    "the async extension must register silent, jobs, and cancel commands",
  );
  const command = commands.find(({ name }) => name === "agentshell-silent");
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
  const warning =
    "Codex CLI has no per-call allowed_tools mechanism; ignoring";

  await withFakeCodex("hidden response", async () => {
    const silentResult = await tool.execute(
      "silent-mode-call",
      {
        agent_type: "codex",
        task_name: "Hidden response",
        allowed_tools: ["Read"],
        prompt: "Return a hidden response",
      },
      undefined,
      (update: CapturedResult) => updates.push(update),
      { cwd: PYTHON_DIR },
    );

    assertRunningJob(silentResult);
    assert.deepEqual(updates, []);
    await waitFor(
      () => sentMessages.length === 1,
      "the silent AgentShell completion",
    );
  });

  assert.deepEqual(sentMessages[0]?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assert.match(sentMessages[0]?.message.content ?? "", /hidden response/);
  assert.equal(sentMessages[0]?.message.details?.silent, true);
  assert.deepEqual(sentMessages[0]?.message.details?.warnings, [warning]);

  const messageRenderer = messageRenderers[0];
  assert.ok(messageRenderer);
  const theme: CapturedTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  for (const expanded of [false, true]) {
    assert.deepEqual(
      messageRenderer.renderer(
        sentMessages[0]?.message as CapturedMessage,
        { expanded, outputPad: 0 },
        theme,
      )?.render(100).map((line) => line.trimEnd()),
      [`Warning: ${warning}`, "✓ Completed"],
    );
  }

  assert.deepEqual(
    messageRenderer.renderer(
      {
        customType: messageRenderer.customType,
        content: "AgentShell failed",
        display: true,
        details: { silent: true, status: "failed", warnings: [] },
      },
      { expanded: false, outputPad: 0 },
      theme,
    )?.render(100).map((line) => line.trimEnd()),
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
  await withFakeCodex("visible response", async () => {
    const visibleResult = await tool.execute(
      "visible-mode-call",
      {
        agent_type: "codex",
        task_name: "Visible response",
        prompt: "Return a visible response",
      },
      undefined,
      (update: CapturedResult) => visibleUpdates.push(update),
      { cwd: PYTHON_DIR },
    );

    assertRunningJob(visibleResult);
    assert.deepEqual(visibleUpdates, []);
    await waitFor(
      () => sentMessages.length === 2,
      "the visible AgentShell completion",
    );
  });

  assert.equal(sentMessages[1]?.message.details?.silent, undefined);
  assert.match(sentMessages[1]?.message.content ?? "", /visible response/);

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
    registerMessageRenderer() {},
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") {
        sessionStart = handler;
      }
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

  const restoredCommand = restoredCommands.find(
    ({ name }) => name === "agentshell-silent",
  );
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
