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

interface CapturedWidget {
  key: string;
  content: string[] | undefined;
  options?: { placement?: string };
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
    errors?: string[];
    silent?: boolean;
  };
}

interface CapturedComponent {
  render(width: number): string[];
}

interface CapturedTool {
  name: string;
  execute: (...args: any[]) => Promise<CapturedResult>;
  renderResult?: (
    result: { content: CapturedResult["content"]; details?: CapturedResult["details"] },
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
  event: { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" },
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

function assertRunningJob(result: CapturedResult): string {
  assert.equal(result.details.status, "running");
  assert.match(
    result.details.jobId ?? "",
    /^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    result.content[0]?.text,
    `Subagent job ${result.details.jobId} started.`,
  );

  return result.details.jobId as string;
}

export default async function silentModeHarness(): Promise<void> {
  const globalSilent = process.env.SILENT_MODE_GLOBAL_DEFAULT === "true";
  let initialSessionStart: SessionStartHandler | undefined;
  const commands: CapturedCommand[] = [];
  const entries: CapturedEntry[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const messageRenderers: CapturedMessageRenderer[] = [];
  const sentMessages: SentMessage[] = [];
  const tools: CapturedTool[] = [];
  const widgets: CapturedWidget[] = [];

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
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") {
        initialSessionStart = handler;
      }
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: CapturedMessage, options: SentMessage["options"]) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);
  assert.ok(initialSessionStart);
  await initialSessionStart(
    { type: "session_start", reason: "startup" },
    { sessionManager: { getBranch: () => [] } },
  );

  assert.equal(
    commands.length,
    5,
    "the extension must register silent, roster, jobs, inspect, and cancel commands",
  );
  const command = commands.find(({ name }) => name === "agentshell-silent");
  const inspectCommand = commands.find(
    ({ name }) => name === "agentshell-inspect",
  );
  assert.ok(inspectCommand);
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

  if (!globalSilent) {
    await command.handler("", context);
  }

  assert.deepEqual(entries, globalSilent ? [] : [
    {
      customType: "agentshell-output-mode",
      data: { silent: true },
    },
  ]);
  assert.deepEqual(notifications, globalSilent ? [] : [
    {
      message: "Subagent responses are now hidden.",
      type: "info",
    },
  ]);

  const tool = tools.find(({ name }) => name === "subagent");
  const statusTool = tools.find(({ name }) => name === "subagent_status");
  assert.ok(tool);
  assert.ok(statusTool);
  const updates: CapturedResult[] = [];
  const warning =
    "Codex CLI has no per-call allowed_tools mechanism; ignoring";
  const theme: CapturedTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };
  const toolContext = {
    cwd: PYTHON_DIR,
    hasUI: true,
    ui: {
      theme,
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: CapturedWidget["options"],
      ) {
        widgets.push({ key, content, options });
      },
    },
  };
  const previousToolCommand = process.env.FAKE_CODEX_TOOL_COMMAND;
  const previousToolDelay = process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS;
  process.env.FAKE_CODEX_TOOL_COMMAND = "npm test";
  process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS = "1";

  try {
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
        toolContext,
      );

      const silentJobId = assertRunningJob(silentResult);
      assert.deepEqual(updates, []);

      // Arrange: inspect before the worker has reported activity or warnings.
      const quietStatus = await statusTool.execute(
        "quiet-mode-status",
        { job_id: silentJobId },
      );
      assert.match(quietStatus.content[0]?.text ?? "", /No activity reported yet/);
      assert.ok(statusTool.renderResult, "status output must have a custom renderer");

      // Act / Assert: rendering hides normal status, even when expanded.
      for (const expanded of [false, true]) {
        assert.deepEqual(
          statusTool.renderResult(
            quietStatus,
            { expanded, isPartial: false },
            theme,
            { isError: false },
          ).render(100),
          [],
        );
      }

      await waitFor(
        () => widgets.at(-1)?.content?.some((line) =>
          line === "   Last activity: shell command: `npm test`"
        ) === true,
        "the silent-mode live activity widget",
      );

      const silentStatus = await statusTool.execute(
        "silent-mode-status",
        { job_id: silentJobId },
        undefined,
        undefined,
        toolContext,
      );
      assert.match(silentStatus.content[0]?.text ?? "", /\[tool\] npm test/);
      assert.match(silentStatus.content[0]?.text ?? "", /\[warning\]/);

      // Act / Assert: only the actual worker warning reaches the terminal.
      for (const expanded of [false, true]) {
        assert.deepEqual(
          statusTool.renderResult(
            silentStatus,
            { expanded, isPartial: false },
            theme,
            { isError: false },
          ).render(100).map((line) => line.trimEnd()),
          [`[warning] ${warning}`],
        );
      }

      // A fresh inspection follows the current mode, not the job's launch mode.
      await command.handler("", context);
      const toggledStatus = await statusTool.execute(
        "toggled-mode-status",
        { job_id: silentJobId },
      );
      assert.equal(
        statusTool.renderResult(
          toggledStatus,
          { expanded: false, isPartial: false },
          theme,
          { isError: false },
        ).render(100).map((line) => line.trimEnd()).join("\n"),
        toggledStatus.content[0]?.text,
      );
      // Already captured results retain their original presentation mode.
      assert.deepEqual(
        statusTool.renderResult(
          quietStatus,
          { expanded: true, isPartial: false },
          theme,
          { isError: false },
        ).render(100),
        [],
      );
      await command.handler("", context);

      const inspectNotifications: Array<{
        message: string;
        type: string;
      }> = [];
      await inspectCommand.handler(silentJobId, {
        ui: {
          notify(message, type) {
            inspectNotifications.push({ message, type });
          },
        },
      });
      assert.equal(inspectNotifications[0]?.type, "info");
      assert.match(
        inspectNotifications[0]?.message ?? "",
        /\[tool\] npm test/,
      );

      await waitFor(
        () => sentMessages.length === 1,
        "the silent AgentShell completion",
      );
      // Delivery hides the activity text but must retain warnings in the terminal.
      const deliveringStatus = await statusTool.execute(
        "delivering-warning-status",
        { job_id: silentJobId },
      );
      assert.equal(deliveringStatus.details.status, "delivering");
      assert.match(deliveringStatus.content[0]?.text ?? "", /Final result is waiting for delivery/);
      assert.doesNotMatch(deliveringStatus.content[0]?.text ?? "", /\[warning\]|\[tool\]/);
      assert.deepEqual(
        statusTool.renderResult(
          deliveringStatus,
          { expanded: false, isPartial: false },
          theme,
          { isError: false },
        ).render(100).map((line) => line.trimEnd()),
        [`[warning] ${warning}`],
      );
    });
  } finally {
    if (previousToolCommand === undefined) {
      delete process.env.FAKE_CODEX_TOOL_COMMAND;
    } else {
      process.env.FAKE_CODEX_TOOL_COMMAND = previousToolCommand;
    }

    if (previousToolDelay === undefined) {
      delete process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS;
    } else {
      process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS = previousToolDelay;
    }
  }

  assert.deepEqual(sentMessages[0]?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assert.match(sentMessages[0]?.message.content ?? "", /hidden response/);
  assert.equal(sentMessages[0]?.message.details?.silent, true);
  assert.deepEqual(sentMessages[0]?.message.details?.warnings, [warning]);

  const messageRenderer = messageRenderers[0];
  assert.ok(messageRenderer);
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

  assert.deepEqual(entries.at(-1), {
    customType: "agentshell-output-mode",
    data: { silent: false },
  });
  assert.deepEqual(notifications.at(-1), {
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

    const visibleJobId = assertRunningJob(visibleResult);
    assert.deepEqual(visibleUpdates, []);

    // Arrange / Act: normal mode still displays the full status response.
    const visibleStatus = await statusTool.execute(
      "visible-mode-status",
      { job_id: visibleJobId },
    );
    assert.ok(statusTool.renderResult);
    for (const expanded of [false, true]) {
      const rendered = statusTool.renderResult(
        visibleStatus,
        { expanded, isPartial: false },
        theme,
        { isError: false },
      ).render(100).map((line) => line.trimEnd()).join("\n");
      assert.equal(rendered, visibleStatus.content[0]?.text);
    }

    await waitFor(
      () => sentMessages.length === 2,
      "the visible AgentShell completion",
    );
  });

  assert.equal(sentMessages[1]?.message.details?.silent, undefined);
  assert.match(sentMessages[1]?.message.content ?? "", /visible response/);

  // Preserve Pi's normal collapsed preview; expanding reveals the full status text.
  assert.ok(statusTool.renderResult);
  const longStatus = {
    content: [{ type: "text", text: [
      "Status line 1", "Status line 2", "Status line 3", "Status line 4",
      "Status line 5", "Status line 6", "Status line 7", "Status line 8",
      "Status line 9", "Status line 10", "Status line 11", "Status line 12",
    ].join("\n") }],
    details: { status: "running", outputTokens: 0, warnings: [], silent: false },
  };
  const collapsedStatus = statusTool.renderResult(
    longStatus,
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  ).render(100).map((line) => line.trimEnd()).join("\n");
  assert.match(collapsedStatus, /Status line 10/);
  assert.doesNotMatch(collapsedStatus, /Status line 11/);
  assert.match(collapsedStatus, /2 more lines/);
  const expandedStatus = statusTool.renderResult(
    longStatus,
    { expanded: true, isPartial: false },
    theme,
    { isError: false },
  ).render(100).map((line) => line.trimEnd()).join("\n");
  assert.equal(expandedStatus, longStatus.content[0].text);

  // Arrange: a real worker reports an error while the status tool is silent.
  await command.handler("", context);
  const previousError = process.env.FAKE_CODEX_ERROR;
  const previousErrorDelay = process.env.FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS;
  process.env.FAKE_CODEX_ERROR = "1";
  process.env.FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS = "1";
  try {
    await withFakeCodex("error smoke reply", async () => {
      const failedLaunch = await tool.execute(
        "error-status-call",
        {
          agent_type: "codex",
          task_name: "Error status smoke test",
          prompt: "Return an error",
        },
        undefined,
        undefined,
        toolContext,
      );
      const failedJobId = assertRunningJob(failedLaunch);
      await waitFor(
        () => widgets.at(-1)?.content?.some((line) =>
          line === "   Last activity: error reported"
        ) === true,
        "the worker error activity",
      );

      // Act
      const errorStatus = await statusTool.execute(
        "error-mode-status",
        { job_id: failedJobId },
      );
      assert.ok(statusTool.renderResult);

      // Assert: the parent keeps full activity, the terminal sees only the error.
      assert.match(errorStatus.content[0]?.text ?? "", /\[text\] error smoke reply/);
      assert.match(errorStatus.content[0]?.text ?? "", /\[error\] fake agent failed/);
      for (const expanded of [false, true]) {
        assert.deepEqual(
          statusTool.renderResult(
            errorStatus,
            { expanded, isPartial: false },
            theme,
            { isError: false },
          ).render(100).map((line) => line.trimEnd()),
          ["[error] fake agent failed"],
        );
      }
      await waitFor(() => sentMessages.length === 3, "the worker error completion");
    });
  } finally {
    if (previousError === undefined) {
      delete process.env.FAKE_CODEX_ERROR;
    } else {
      process.env.FAKE_CODEX_ERROR = previousError;
    }
    if (previousErrorDelay === undefined) {
      delete process.env.FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS;
    } else {
      process.env.FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS = previousErrorDelay;
    }
  }

  // A noisy worker must not expand the bounded inspection window in metadata or on screen.
  const previousErrorCount = process.env.FAKE_CODEX_ERROR_COUNT;
  const previousErrorSuffix = process.env.FAKE_CODEX_ERROR_SUFFIX;
  const previousNoisyDelay = process.env.FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS;
  process.env.FAKE_CODEX_ERROR_COUNT = "25";
  process.env.FAKE_CODEX_ERROR_SUFFIX = "x".repeat(500);
  process.env.FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS = "1";
  try {
    await withFakeCodex("noisy worker reply", async () => {
      const launch = await tool.execute(
        "noisy-status-call",
        {
          agent_type: "codex",
          task_name: "Noisy status smoke test",
          prompt: "Return many errors",
          allowed_tools: ["Read"],
        },
        undefined,
        undefined,
        toolContext,
      );
      const jobId = assertRunningJob(launch);
      let status: CapturedResult;
      // Wait for the last observable error, not a fixed sleep or a hidden widget row.
      const deadline = Date.now() + 5_000;
      do {
        status = await statusTool.execute("noisy-status", { job_id: jobId });
        if (status.content[0]?.text.includes("[error] fake agent failed 25 ")) break;
        assert.ok(Date.now() < deadline, "timed out waiting for the final noisy error");
        await delay(10);
      } while (true);

      // Assert: only errors 6–25 remain in the 20-entry inspection window.
      assert.equal(status.details.errors?.length, 20);
      assert.deepEqual(status.details.warnings, []);
      assert.match(status.details.errors?.[0] ?? "", /^\[error\] fake agent failed 6 /);
      assert.match(status.details.errors?.at(-1) ?? "", /^\[error\] fake agent failed 25 /);
      assert.ok(status.details.errors?.every((entry) => entry.length <= 408));
      assert.ok(status.details.errors?.every((entry) => entry.endsWith("…")));
      assert.ok(statusTool.renderResult);
      const rendered = statusTool.renderResult(
        status,
        { expanded: true, isPartial: false },
        theme,
        { isError: false },
      ).render(100).map((line) => line.trimEnd()).join("\n");
      assert.doesNotMatch(rendered, /\[warning\]/);
      assert.doesNotMatch(rendered, /fake agent failed 5 /);
      await waitFor(() => sentMessages.length === 4, "the noisy worker completion");
    });
  } finally {
    for (const [name, value] of [
      ["FAKE_CODEX_ERROR_COUNT", previousErrorCount],
      ["FAKE_CODEX_ERROR_SUFFIX", previousErrorSuffix],
      ["FAKE_CODEX_AFTER_ERROR_DELAY_SECONDS", previousNoisyDelay],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  // Lookup failures become Pi error results without details; they must not disappear.
  await assert.rejects(
    statusTool.execute("missing-status", { job_id: "missing-job" }),
    /No active subagent job found with ID missing-job/,
  );
  assert.ok(statusTool.renderResult);
  const lookupFailure = "No active subagent job found with ID missing-job.";
  assert.deepEqual(
    statusTool.renderResult(
      { content: [{ type: "text", text: lookupFailure }] },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    ).render(100).map((line) => line.trimEnd()),
    [lookupFailure],
  );

  // Status and lookup errors must not send ANSI/OSC, CR or binary control codes to the terminal.
  for (const isError of [false, true]) {
    const unsafeText = "\u001b[31mTask\u001b[0m: red\r\n"
      + "\u001b]8;;https://example.test\u0007Link\u001b]8;;\u0007\nControl\u0000 text";
    assert.deepEqual(
      statusTool.renderResult(
        { content: [{ type: "text", text: unsafeText }] },
        { expanded: true, isPartial: false },
        theme,
        { isError },
      ).render(100).map((line) => line.trimEnd()),
      ["Task: red", "Link", "Control text"],
    );
  }

  // A failed status remains visible even if Pi doesn't mark the inspection itself as an error.
  const failedStatusText = "Subagent job failed.\nWorker exited unexpectedly.";
  assert.deepEqual(
    statusTool.renderResult(
      {
        content: [{ type: "text", text: failedStatusText }],
        details: { status: "failed", silent: true, warnings: [], outputTokens: 0 },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    ).render(100).map((line) => line.trimEnd()).join("\n"),
    failedStatusText,
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

  // Saved session choices must override either global default, including explicit false.
  for (const reason of ["reload", "resume"] as const) {
    for (const savedSilent of [false, true]) {
      // Arrange
      restoredEntries.length = 0;
      restoredNotifications.length = 0;

      // Act
      await sessionStart(
        { type: "session_start", reason },
        {
          sessionManager: {
            getBranch: () => [
              {
                type: "custom",
                customType: "agentshell-output-mode",
                data: { silent: !savedSilent },
              },
              {
                type: "custom",
                customType: "agentshell-output-mode",
                data: { silent: savedSilent },
              },
            ],
          },
        },
      );
      await restoredCommand.handler("", {
        ui: {
          notify(message, type) {
            restoredNotifications.push({ message, type });
          },
        },
      });

      // Assert: toggling flips the last saved choice, not the global default.
      assert.deepEqual(restoredEntries, [{
        customType: "agentshell-output-mode",
        data: { silent: !savedSilent },
      }]);
      assert.equal(
        restoredNotifications[0]?.message,
        savedSilent
          ? "Subagent responses are now visible."
          : "Subagent responses are now hidden.",
      );
    }
  }

  // A new session resets the previous session's choice to the global default.
  restoredEntries.length = 0;
  await sessionStart(
    { type: "session_start", reason: "new" },
    { sessionManager: { getBranch: () => [] } },
  );
  await restoredCommand.handler("", { ui: { notify() {} } });
  assert.deepEqual(restoredEntries, [{
    customType: "agentshell-output-mode",
    data: { silent: !globalSilent },
  }]);

  process.stderr.write("SILENT_MODE_COMMAND_OK\n");
}
