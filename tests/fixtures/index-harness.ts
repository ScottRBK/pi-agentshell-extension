import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../../index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PYTHON_DIR = join(ROOT, "python");
const FAKE_BIN = join(PYTHON_DIR, "tests", "fixtures", "bin");

interface CapturedResult {
  content: Array<{ type: string; text: string }>;
  details: {
    status: string;
    jobId?: string;
    sessionId?: string;
    models?: string[];
    outputTokens: number;
    warnings: string[];
  };
}

interface CapturedCommand {
  name: string;
  handler(args: string, context: CommandContext): Promise<void>;
}

interface CommandContext {
  hasUI: boolean;
  ui: {
    theme: CapturedTheme;
    notify(message: string, type: string): void;
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: CapturedWidget["options"],
    ): void;
  };
}

interface CapturedMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: {
    jobId?: string;
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

interface CapturedWidget {
  key: string;
  content: string[] | undefined;
  options?: {
    placement?: string;
  };
}

type SessionStartHandler = (
  event: { type: "session_start" },
  context: {
    sessionManager: { getBranch(): [] };
  },
) => Promise<void> | void;

type SessionShutdownHandler = (
  event: { type: "session_shutdown" },
  context: unknown,
) => Promise<void> | void;

type MessageStartHandler = (
  event: {
    type: "message_start";
    message: CapturedMessage & { role: "custom" };
  },
  context: unknown,
) => Promise<void> | void;

interface CapturedCallArguments {
  agent_type: string;
  prompt: string;
  model?: string;
  effort?: string;
}

interface CapturedTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

interface CapturedComponent {
  render(width: number): string[];
}

interface CapturedTool {
  name: string;
  description: string;
  parameters: {
    required?: string[];
    properties?: {
      agent_type?: {
        enum?: string[];
      };
      task_name?: {
        type?: string;
        minLength?: number;
        maxLength?: number;
      };
      cwd?: {
        type?: string;
      };
      model?: {
        type?: string;
        minLength?: number;
      };
      effort?: {
        type?: string;
        minLength?: number;
      };
      resume_session_id?: {
        anyOf?: Array<{
          type?: string;
          minLength?: number;
        }>;
        description?: string;
      };
      session_id?: {
        type?: string;
        minLength?: number;
      };
      auto_approve?: {
        type?: string;
      };
      allowed_tools?: {
        type?: string;
        minItems?: number;
        items?: {
          type?: string;
          minLength?: number;
        };
      };
      disallowed_tools?: {
        type?: string;
        minItems?: number;
        items?: {
          type?: string;
          minLength?: number;
        };
      };
      job_id?: {
        type?: string;
        minLength?: number;
      };
    };
  };
  execute: (...args: any[]) => Promise<CapturedResult>;
  renderCall?: (
    args: CapturedCallArguments,
    theme: CapturedTheme,
    context: unknown,
  ) => CapturedComponent;
  renderResult?: (
    result: CapturedResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: CapturedTheme,
    context: { isError: boolean },
  ) => CapturedComponent;
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

function countFileLines(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .length;
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

export default async function indexHarness(): Promise<void> {
  const commands: CapturedCommand[] = [];
  const sentMessages: SentMessage[] = [];
  const sessionStartHandlers: SessionStartHandler[] = [];
  const shutdownHandlers: SessionShutdownHandler[] = [];
  const messageStartHandlers: MessageStartHandler[] = [];
  const tools: CapturedTool[] = [];
  let deferMessageDelivery = false;
  let rejectActivityWidget = false;
  let eventContext: unknown;

  const deliverMessage = (message: CapturedMessage): void => {
    const event = {
      type: "message_start" as const,
      message: { role: "custom" as const, ...message },
    };

    for (const handler of messageStartHandlers) {
      void handler(event, eventContext);
    }
  };

  const fakePi = {
    registerCommand(name: string, command: Omit<CapturedCommand, "name">) {
      commands.push({ name, ...command });
    },
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    registerMessageRenderer() {},
    on(
      event: string,
      handler:
        | SessionStartHandler
        | SessionShutdownHandler
        | MessageStartHandler,
    ) {
      if (event === "session_start") {
        sessionStartHandlers.push(handler as SessionStartHandler);
      } else if (event === "session_shutdown") {
        shutdownHandlers.push(handler as SessionShutdownHandler);
      } else if (event === "message_start") {
        messageStartHandlers.push(handler as MessageStartHandler);
      }
    },
    appendEntry() {},
    sendMessage(message: CapturedMessage, options: SentMessage["options"]) {
      sentMessages.push({ message, options });

      if (!deferMessageDelivery) {
        deliverMessage(message);
      }
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);

  assert.equal(tools.length, 4);
  assert.equal(
    shutdownHandlers.length,
    1,
    "the extension must cancel outstanding jobs on session shutdown",
  );

  const tool = tools.find(({ name }) => name === "subagent");
  const cancelTool = tools.find(({ name }) => name === "subagent_cancel");
  const statusTool = tools.find(({ name }) => name === "subagent_status");
  const modelsTool = tools.find(
    ({ name }) => name === "subagent_list_models",
  );
  assert.ok(tool);
  assert.ok(cancelTool);
  assert.ok(statusTool);
  assert.ok(modelsTool);

  const widgets: CapturedWidget[] = [];
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
        if (
          rejectActivityWidget &&
          content?.some((line) => line.includes("Last activity"))
        ) {
          rejectActivityWidget = false;
          throw new Error("activity widget failed");
        }

        widgets.push({ key, content, options });
      },
    },
  };
  eventContext = toolContext;

  assert.match(tool.description, /Long-running subagent calls may return/i);
  assert.match(tool.description, /Do not repeatedly poll/i);
  assert.match(tool.description, /subagent_status.*progress is useful/i);
  assert.match(tool.description, /sleep commands/i);
  assert.match(tool.description, /A Job ID is not a session ID/i);
  assert.match(tool.description, /automatically delivers.*follow-up turn/i);
  assert.match(tool.description, /Continue other work or remain idle/i);
  assert.match(tool.description, /resumable session ID.*completion result/i);
  assert.match(
    tool.description,
    /Omit `resume_session_id` for a new session/i,
  );
  assert.match(
    tool.description,
    /tool-call interface requires.*property.*use `null`/i,
  );
  assert.match(
    tool.description,
    /earlier successful subagent result/i,
  );
  assert.match(
    tool.description,
    /Do not pass `new`, a background Job ID, or a newly generated UUID/i,
  );
  assert.deepEqual(tool.parameters.required, [
    "agent_type",
    "task_name",
    "prompt",
  ]);
  assert.equal(tool.parameters.properties?.task_name?.type, "string");
  assert.equal(tool.parameters.properties?.task_name?.minLength, 1);
  assert.equal(tool.parameters.properties?.task_name?.maxLength, 40);
  assert.deepEqual(cancelTool.parameters.required, ["job_id"]);
  assert.equal(cancelTool.parameters.properties?.job_id?.type, "string");
  assert.equal(cancelTool.parameters.properties?.job_id?.minLength, 1);
  assert.deepEqual(statusTool.parameters.required, ["job_id"]);
  assert.equal(statusTool.parameters.properties?.job_id?.type, "string");
  assert.equal(statusTool.parameters.properties?.job_id?.minLength, 1);
  assert.deepEqual(modelsTool.parameters.required, ["agent_type"]);
  assert.equal(modelsTool.parameters.properties?.cwd?.type, "string");

  if (process.env.INDEX_LIMIT_TEST === "1") {
    const previousPath = process.env.PATH;
    const previousResponse = process.env.FAKE_CODEX_RESPONSE;

    process.env.PATH = FAKE_BIN;
    process.env.FAKE_CODEX_RESPONSE = "ab🙂cd";

    try {
      const result = await tool.execute(
        "index-test-output-limit",
        {
          agent_type: "codex",
          task_name: "Output limit",
          prompt: "Return too much output",
        },
        undefined,
        undefined,
        toolContext,
      );

      assertRunningJob(result);
      await waitFor(
        () => sentMessages.length === 1,
        "the output-limit failure message",
      );
      assert.equal(sentMessages[0]?.message.details?.status, "failed");
      assert.match(
        sentMessages[0]?.message.content ?? "",
        /AgentShell output exceeded the 5 byte limit/,
      );
      assert.match(
        sentMessages[0]?.message.content ?? "",
        /Partial output \(truncated\):\nab/,
      );
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

    process.stderr.write("INDEX_LIMIT_HARNESS_OK\n");
    return;
  }

  assert.equal(tool.parameters.properties?.cwd?.type, "string");
  assert.equal(tool.parameters.properties?.model?.type, "string");
  assert.equal(tool.parameters.properties?.model?.minLength, 1);
  assert.equal(tool.parameters.properties?.effort?.type, "string");
  assert.equal(tool.parameters.properties?.effort?.minLength, 1);
  const resumeSessionSchema =
    tool.parameters.properties?.resume_session_id;
  assert.deepEqual(
    resumeSessionSchema?.anyOf?.map(({ type }) => type),
    ["string", "null"],
  );
  assert.equal(resumeSessionSchema?.anyOf?.[0]?.minLength, 1);
  assert.equal(tool.parameters.properties?.session_id, undefined);
  assert.match(
    resumeSessionSchema?.description ?? "",
    /omit `resume_session_id` for a new session/i,
  );
  assert.match(
    resumeSessionSchema?.description ?? "",
    /tool-call interface requires.*property.*use `null`/i,
  );
  assert.match(
    resumeSessionSchema?.description ?? "",
    /earlier successful subagent result/i,
  );
  assert.match(
    resumeSessionSchema?.description ?? "",
    /Do not pass `new`, a background Job ID, or a newly generated UUID/i,
  );
  assert.equal(tool.parameters.properties?.auto_approve?.type, "boolean");
  assert.equal(tool.parameters.properties?.allowed_tools?.type, "array");
  assert.equal(tool.parameters.properties?.allowed_tools?.minItems, 1);
  assert.equal(
    tool.parameters.properties?.allowed_tools?.items?.type,
    "string",
  );
  assert.equal(
    tool.parameters.properties?.allowed_tools?.items?.minLength,
    1,
  );
  assert.equal(tool.parameters.properties?.disallowed_tools?.type, "array");
  assert.equal(tool.parameters.properties?.disallowed_tools?.minItems, 1);
  assert.equal(
    tool.parameters.properties?.disallowed_tools?.items?.type,
    "string",
  );
  assert.equal(
    tool.parameters.properties?.disallowed_tools?.items?.minLength,
    1,
  );

  const agentTypes = tool.parameters.properties?.agent_type?.enum;
  assert.ok(agentTypes);
  assert.ok(agentTypes.length > 0);
  assert.ok(agentTypes.includes("codex"));
  assert.equal(new Set(agentTypes).size, agentTypes.length);
  assert.deepEqual(
    modelsTool.parameters.properties?.agent_type?.enum,
    agentTypes,
  );

  const renderCall = tool.renderCall;
  assert.ok(renderCall);

  assert.deepEqual(
    renderCall(
      {
        agent_type: "codex",
        prompt: "Review this project",
      },
      theme,
      {},
    ).render(100).map((line) => line.trimEnd()),
    ["Subagent codex"],
  );
  assert.deepEqual(
    renderCall(
      {
        agent_type: "codex",
        prompt: "Review this project",
        model: "test-model",
        effort: "high",
      },
      theme,
      {},
    ).render(100).map((line) => line.trimEnd()),
    ["Subagent codex · model: test-model · effort: high"],
  );

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "pi-subagent-cwd-"),
  );
  const argumentsFile = join(temporaryDirectory, "arguments");
  const cwdFile = join(temporaryDirectory, "cwd");
  const startedFile = join(temporaryDirectory, "started");
  const overriddenCwd = join(temporaryDirectory, "overridden-cwd");
  mkdirSync(overriddenCwd);

  const previousPath = process.env.PATH;
  const previousArgumentsFile = process.env.FAKE_CODEX_ARGS_FILE;
  const previousCwdFile = process.env.FAKE_CODEX_CWD_FILE;
  const previousStartedFile = process.env.FAKE_CODEX_STARTED_FILE;
  const previousDelay = process.env.FAKE_CODEX_DELAY_SECONDS;
  const previousError = process.env.FAKE_CODEX_ERROR;
  const previousRecoveredPiError = process.env.FAKE_PI_RECOVERED_ERROR;
  const previousToolCommand = process.env.FAKE_CODEX_TOOL_COMMAND;
  const previousToolDelay = process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS;
  const previousResultDelay = process.env.FAKE_CODEX_RESULT_DELAY_SECONDS;
  const previousResponseJson = process.env.FAKE_CODEX_RESPONSE_JSON;
  process.env.PATH = FAKE_BIN;
  process.env.FAKE_CODEX_ARGS_FILE = argumentsFile;
  process.env.FAKE_CODEX_CWD_FILE = cwdFile;

  try {
    const defaultModels = await modelsTool.execute(
      "index-test-list-default-models",
      { agent_type: "codex" },
      undefined,
      undefined,
      toolContext,
    );

    assert.deepEqual(defaultModels.details.models, [
      "gpt-5",
      "gpt-5-codex",
    ]);
    assert.equal(
      defaultModels.content[0]?.text,
      "[\"gpt-5\",\"gpt-5-codex\"]",
    );
    assert.equal(readFileSync(cwdFile, "utf8").trim(), PYTHON_DIR);

    const overriddenModels = await modelsTool.execute(
      "index-test-list-overridden-models",
      { agent_type: "codex", cwd: overriddenCwd },
      undefined,
      undefined,
      toolContext,
    );

    assert.deepEqual(overriddenModels.details.models, [
      "gpt-5",
      "gpt-5-codex",
    ]);
    assert.equal(readFileSync(cwdFile, "utf8").trim(), overriddenCwd);
    rmSync(cwdFile);

    const updates: CapturedResult[] = [];
    const notifications: Array<{ message: string; type: string }> = [];
    const commandContext: CommandContext = {
      hasUI: true,
      ui: {
        theme,
        notify(message, type) {
          notifications.push({ message, type });
        },
        setWidget(key, content, options) {
          widgets.push({ key, content, options });
        },
      },
    };
    const jobsCommand = commands.find(({ name }) => name === "agentshell-jobs");
    const inspectCommand = commands.find(
      ({ name }) => name === "agentshell-inspect",
    );
    const cancelCommand = commands.find(({ name }) => name === "agentshell-cancel");
    assert.ok(jobsCommand, "the extension must register /agentshell-jobs");
    assert.ok(
      inspectCommand,
      "the extension must register /agentshell-inspect",
    );
    assert.ok(cancelCommand, "the extension must register /agentshell-cancel");

    process.env.FAKE_CODEX_DELAY_SECONDS = "1";
    deferMessageDelivery = true;
    const submittedAt = Date.now();
    const defaultResult = await tool.execute(
      "index-test-default-cwd",
      {
        agent_type: "codex",
        task_name: "Default cwd",
        prompt: "Return a test response",
      },
      undefined,
      (update: CapturedResult) => updates.push(update),
      toolContext,
    );

    const defaultJobId = assertRunningJob(defaultResult);
    assert.ok(Date.now() - submittedAt < 500, "subagent submission waited for completion");
    assert.deepEqual(updates, []);
    const defaultWidgetIdentity =
      `Default cwd · codex/default/default · ${defaultJobId.slice(0, 12)}`;
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: [
        "● Background agents · 1 running",
        `└─ ${defaultWidgetIdentity}`,
      ],
      options: { placement: "aboveEditor" },
    });
    await waitForFile(cwdFile);
    assert.equal(
      readFileSync(cwdFile, "utf8").trim(),
      PYTHON_DIR,
    );
    const freshArguments = readFileSync(argumentsFile, "utf8")
      .split(/\r?\n/);
    assert.ok(!freshArguments.includes("resume"));

    await jobsCommand.handler("", commandContext);
    assert.equal(
      notifications.at(-1)?.message,
      [
        `${defaultJobId}: running`,
        "  Default cwd · codex · default · effort: default",
      ].join("\n"),
    );

    delete process.env.FAKE_CODEX_DELAY_SECONDS;
    await waitFor(
      () => sentMessages.length === 1,
      "the successful AgentShell completion",
    );
    assert.deepEqual(sentMessages[0]?.options, {
      triggerTurn: true,
      deliverAs: "followUp",
    });
    assert.match(sentMessages[0]?.message.content ?? "", /test response/);
    assert.match(sentMessages[0]?.message.content ?? "", /Session ID: test-session/);
    assert.equal(sentMessages[0]?.message.details?.status, "completed");
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: [
        "◆ Background agents · 1 delivering",
        `└─ ${defaultWidgetIdentity} · completed · delivering…`,
      ],
      options: { placement: "aboveEditor" },
    });
    await jobsCommand.handler("", commandContext);
    assert.equal(
      notifications.at(-1)?.message,
      [
        `${defaultJobId}: delivering`,
        "  Default cwd · codex · default · effort: default",
      ].join("\n"),
    );

    const deliveringStatus = await statusTool.execute(
      "index-test-delivering-status",
      { job_id: defaultJobId },
      undefined,
      undefined,
      toolContext,
    );
    assert.equal(deliveringStatus.details.status, "delivering");
    const expectedDeliveringInspection = [
      `Subagent job ${defaultJobId}: delivering`,
      "Task: Default cwd",
      "Agent: codex/default/default",
      "Final result is waiting for delivery.",
    ].join("\n");
    assert.equal(
      deliveringStatus.content[0]?.text,
      expectedDeliveringInspection,
    );
    assert.doesNotMatch(deliveringStatus.content[0]?.text ?? "", /test response/);

    await inspectCommand.handler(defaultJobId, commandContext);
    assert.equal(
      notifications.at(-1)?.message,
      expectedDeliveringInspection,
    );

    const firstMessage = sentMessages[0]?.message;
    assert.ok(firstMessage);
    deliverMessage(firstMessage);
    deferMessageDelivery = false;
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: undefined,
      options: { placement: "aboveEditor" },
    });

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", /no .*jobs/i);

    rmSync(cwdFile, { force: true });
    const overriddenResult = await tool.execute(
      "index-test-overridden-cwd",
      {
        agent_type: "codex",
        task_name: "Override cwd",
        cwd: overriddenCwd,
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      toolContext,
    );

    assertRunningJob(overriddenResult);
    await waitForFile(cwdFile);
    await waitFor(
      () => sentMessages.length === 2,
      "the overridden-cwd AgentShell completion",
    );
    assert.equal(
      readFileSync(cwdFile, "utf8").trim(),
      overriddenCwd,
    );

    rmSync(argumentsFile, { force: true });
    const controlledResult = await tool.execute(
      "index-test-controls",
      {
        agent_type: "codex",
        task_name: "Control options",
        model: "test-model",
        effort: "high",
        auto_approve: true,
        allowed_tools: ["Read"],
        disallowed_tools: ["web_search"],
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      toolContext,
    );

    const warning =
      "Codex CLI has no per-call allowed_tools mechanism; ignoring";

    assertRunningJob(controlledResult);
    await waitFor(
      () => sentMessages.length === 3,
      "the controlled AgentShell completion",
    );

    const agentArguments = readFileSync(argumentsFile, "utf8")
      .split(/\r?\n/);
    const modelIndex = agentArguments.indexOf("--model");
    assert.notEqual(modelIndex, -1);
    assert.equal(agentArguments[modelIndex + 1], "test-model");
    assert.ok(agentArguments.includes('model_reasoning_effort="high"'));
    assert.ok(
      agentArguments.includes(
        "--dangerously-bypass-approvals-and-sandbox",
      ),
    );
    assert.ok(agentArguments.includes('web_search="disabled"'));

    rmSync(argumentsFile, { force: true });
    const resumedResult = await tool.execute(
      "index-test-resume",
      {
        agent_type: "codex",
        task_name: "Resume task",
        prompt: "Continue the task",
        resume_session_id: "existing-session",
      },
      undefined,
      undefined,
      toolContext,
    );

    assertRunningJob(resumedResult);
    await waitFor(
      () => sentMessages.length === 4,
      "the resumed AgentShell completion",
    );

    const resumedArguments = readFileSync(argumentsFile, "utf8")
      .split(/\r?\n/);
    assert.ok(resumedArguments.includes("resume"));
    assert.ok(resumedArguments.includes("existing-session"));

    assert.match(sentMessages[2]?.message.content ?? "", new RegExp(warning));

    process.env.FAKE_CODEX_ERROR = "1";
    const failedResult = await tool.execute(
      "index-test-failed",
      {
        agent_type: "codex",
        task_name: "Expected failure",
        prompt: "Fail after returning partial output",
      },
      undefined,
      undefined,
      toolContext,
    );
    assertRunningJob(failedResult);
    await waitFor(
      () => sentMessages.length === 5,
      "the failed AgentShell completion",
    );
    assert.match(sentMessages.at(-1)?.message.content ?? "", /fake agent failed/);
    assert.equal(sentMessages.at(-1)?.message.details?.status, "failed");
    delete process.env.FAKE_CODEX_ERROR;

    process.env.FAKE_PI_RECOVERED_ERROR = "1";
    const recoveredResult = await tool.execute(
      "index-test-recovered-pi",
      {
        agent_type: "pi",
        task_name: "Recovered Pi",
        prompt: "Recover from a transient transport error",
      },
      undefined,
      undefined,
      toolContext,
    );
    assertRunningJob(recoveredResult);
    await waitFor(
      () => sentMessages.length === 6,
      "the recovered Pi completion",
    );
    const recoveredMessage = sentMessages.at(-1)?.message;
    assert.equal(recoveredMessage?.details?.status, "completed");
    assert.match(recoveredMessage?.content ?? "", /recovered pi response/);
    assert.match(
      recoveredMessage?.content ?? "",
      /Session ID: pi-recovered-session/,
    );
    assert.doesNotMatch(
      recoveredMessage?.content ?? "",
      /transient transport error/,
    );
    delete process.env.FAKE_PI_RECOVERED_ERROR;

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", /no .*jobs/i);

    process.env.FAKE_CODEX_STARTED_FILE = startedFile;
    process.env.FAKE_CODEX_DELAY_SECONDS = "2";

    const cancelledResult = await tool.execute(
      "index-test-cancelled",
      {
        agent_type: "codex",
        task_name: "Cancel tool",
        prompt: "Wait for cancellation",
      },
      undefined,
      undefined,
      toolContext,
    );

    const cancelledJobId = assertRunningJob(cancelledResult);
    await waitForFile(startedFile);
    await assert.rejects(
      cancelTool.execute(
        "index-test-agent-cancel-mistyped",
        { job_id: "job-mistyped" },
        undefined,
        undefined,
        toolContext,
      ),
      new RegExp(cancelledJobId),
    );
    const cancellation = await cancelTool.execute(
      "index-test-agent-cancel",
      { job_id: cancelledJobId },
      undefined,
      undefined,
      toolContext,
    );
    assert.equal(cancellation.details.status, "cancelled");
    assert.equal(cancellation.details.jobId, cancelledJobId);
    assert.match(cancellation.content[0]?.text ?? "", /cancelled/i);
    const cancelledWidgetIdentity =
      `Cancel tool · codex/default/default · ${cancelledJobId.slice(0, 12)}`;
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: [
        "■ Background agents · 1 cancelling",
        `└─ ${cancelledWidgetIdentity} · cancelling…`,
      ],
      options: { placement: "aboveEditor" },
    });
    await assert.rejects(
      cancelTool.execute(
        "index-test-agent-cancel-again",
        { job_id: cancelledJobId },
        undefined,
        undefined,
        toolContext,
      ),
      /No running subagent job found/,
    );
    await assert.rejects(
      cancelTool.execute(
        "index-test-agent-cancel-unknown",
        { job_id: "job-unknown" },
        undefined,
        undefined,
        toolContext,
      ),
      /No running subagent job found/,
    );
    await waitFor(
      () => sentMessages.length === 7,
      "the cancelled AgentShell completion",
    );
    assert.match(sentMessages.at(-1)?.message.content ?? "", /cancelled|aborted/i);
    assert.equal(sentMessages.at(-1)?.message.details?.status, "cancelled");

    await cancelCommand.handler("", commandContext);
    assert.equal(notifications.at(-1)?.type, "warning");
    assert.match(notifications.at(-1)?.message ?? "", /Usage:/);

    await cancelCommand.handler("job-unknown", commandContext);
    assert.equal(notifications.at(-1)?.type, "warning");
    assert.match(notifications.at(-1)?.message ?? "", /No running subagent job found/);

    rmSync(startedFile, { force: true });
    const commandCancelledResult = await tool.execute(
      "index-test-command-cancelled",
      {
        agent_type: "codex",
        task_name: "Command cancel",
        prompt: "Wait for slash-command cancellation",
      },
      undefined,
      undefined,
      toolContext,
    );
    const commandCancelledJobId = assertRunningJob(commandCancelledResult);
    await waitForFile(startedFile);
    await cancelCommand.handler("job-mistyped", commandContext);
    assert.equal(notifications.at(-1)?.type, "warning");
    assert.match(
      notifications.at(-1)?.message ?? "",
      new RegExp(commandCancelledJobId),
    );
    await cancelCommand.handler(commandCancelledJobId, commandContext);
    assert.equal(notifications.at(-1)?.type, "info");
    assert.match(notifications.at(-1)?.message ?? "", /cancelled/i);
    const commandCancelledIdentity =
      `Command cancel · codex/default/default · ${
        commandCancelledJobId.slice(0, 12)
      }`;
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: [
        "■ Background agents · 1 cancelling",
        `└─ ${commandCancelledIdentity} · cancelling…`,
      ],
      options: { placement: "aboveEditor" },
    });
    await waitFor(
      () => sentMessages.length === 8,
      "the slash-command cancelled AgentShell completion",
    );
    assert.equal(sentMessages.at(-1)?.message.details?.status, "cancelled");

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", /no .*jobs/i);

    process.env.FAKE_CODEX_STARTED_FILE = startedFile;
    process.env.FAKE_CODEX_DELAY_SECONDS = "5";
    deferMessageDelivery = true;
    rmSync(startedFile, { force: true });
    const sentBeforeOverflow = sentMessages.length;
    const overflowResults = await Promise.all(
      Array.from({ length: 5 }, (_value, index) =>
        tool.execute(
          `index-test-overflow-${index + 1}`,
          {
            agent_type: "codex",
            task_name: `Overflow ${index + 1}`,
            model: `model-${index + 1}`,
            effort: "medium",
            prompt: `Wait as background job ${index + 1}`,
          },
          undefined,
          undefined,
          toolContext,
        )
      ),
    );
    const overflowJobIds = overflowResults.map(assertRunningJob);
    const overflowWidgetIdentities = overflowJobIds.map((jobId, index) =>
      `Overflow ${index + 1} · codex/model-${index + 1}/medium · ${
        jobId.slice(0, 12)
      }`
    );
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: [
        "● Background agents · 5 running",
        `├─ ${overflowWidgetIdentities[0]}`,
        `├─ ${overflowWidgetIdentities[1]}`,
        `├─ ${overflowWidgetIdentities[2]}`,
        "└─ +2 more running · /agentshell-jobs",
      ],
      options: { placement: "aboveEditor" },
    });
    await waitFor(
      () => countFileLines(startedFile) === overflowJobIds.length,
      "all overflow AgentShell workers to start",
    );
    await assert.rejects(
      cancelTool.execute(
        "index-test-overflow-cancel-mistyped",
        { job_id: "job-mistyped" },
        undefined,
        undefined,
        toolContext,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);

        for (const jobId of overflowJobIds) {
          assert.match(error.message, new RegExp(jobId));
        }

        return true;
      },
    );
    await cancelTool.execute(
      "index-test-overflow-cancel-1",
      { job_id: overflowJobIds[0] },
      undefined,
      undefined,
      toolContext,
    );
    assert.deepEqual(widgets.at(-1)?.content, [
      "● Background agents · 4 running · 1 cancelling",
      `├─ ${overflowWidgetIdentities[0]} · cancelling…`,
      `├─ ${overflowWidgetIdentities[1]}`,
      `├─ ${overflowWidgetIdentities[2]}`,
      "└─ +2 more running · /agentshell-jobs",
    ]);
    await waitFor(
      () => sentMessages.length === sentBeforeOverflow + 1,
      "the first overflow AgentShell cancellation",
    );
    assert.deepEqual(widgets.at(-1)?.content, [
      "● Background agents · 4 running · 1 delivering",
      `├─ ${overflowWidgetIdentities[0]} · cancelled · delivering…`,
      `├─ ${overflowWidgetIdentities[1]}`,
      `├─ ${overflowWidgetIdentities[2]}`,
      "└─ +2 more running · /agentshell-jobs",
    ]);
    const firstOverflowMessage = sentMessages[sentBeforeOverflow]?.message;
    assert.ok(firstOverflowMessage);
    deliverMessage(firstOverflowMessage);
    assert.deepEqual(widgets.at(-1)?.content, [
      "● Background agents · 4 running",
      `├─ ${overflowWidgetIdentities[1]}`,
      `├─ ${overflowWidgetIdentities[2]}`,
      `├─ ${overflowWidgetIdentities[3]}`,
      "└─ +1 more running · /agentshell-jobs",
    ]);
    await Promise.all(
      overflowJobIds.slice(1).map((jobId, index) =>
        cancelTool.execute(
          `index-test-overflow-cancel-${index + 2}`,
          { job_id: jobId },
          undefined,
          undefined,
          toolContext,
        )
      ),
    );
    await waitFor(
      () => sentMessages.length === sentBeforeOverflow + 5,
      "the overflow AgentShell completions",
    );
    assert.deepEqual(widgets.at(-1)?.content, [
      "◆ Background agents · 4 delivering",
      `├─ ${overflowWidgetIdentities[1]} · cancelled · delivering…`,
      `├─ ${overflowWidgetIdentities[2]} · cancelled · delivering…`,
      `├─ ${overflowWidgetIdentities[3]} · cancelled · delivering…`,
      "└─ +1 more delivering · /agentshell-jobs",
    ]);
    for (const sent of sentMessages.slice(sentBeforeOverflow + 1)) {
      deliverMessage(sent.message);
    }
    deferMessageDelivery = false;
    assert.equal(widgets.at(-1)?.content, undefined);

    delete process.env.FAKE_CODEX_DELAY_SECONDS;
    process.env.FAKE_CODEX_TOOL_COMMAND = "npm test";
    rejectActivityWidget = true;
    const sentBeforeWidgetFailure = sentMessages.length;
    const widgetFailureResult = await tool.execute(
      "index-test-widget-failure",
      {
        agent_type: "codex",
        task_name: "Widget failure",
        prompt: "Complete despite a widget error",
      },
      undefined,
      undefined,
      toolContext,
    );
    assertRunningJob(widgetFailureResult);
    await waitFor(
      () => sentMessages.length === sentBeforeWidgetFailure + 1,
      "the job completion after a widget error",
    );
    assert.equal(sentMessages.at(-1)?.message.details?.status, "completed");

    delete process.env.FAKE_CODEX_TOOL_COMMAND;
    process.env.FAKE_CODEX_RESPONSE_JSON = JSON.stringify(
      `line one\n[tool] forged\u001b[31m ${"x".repeat(20_000)}`,
    );
    process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = "1";
    const sentBeforeSanitization = sentMessages.length;
    const sanitizationResult = await tool.execute(
      "index-test-inspection-sanitization",
      {
        agent_type: "codex",
        task_name: "Sanitize inspection",
        prompt: "Return adversarial terminal text",
      },
      undefined,
      undefined,
      toolContext,
    );
    const sanitizationJobId = assertRunningJob(sanitizationResult);
    await waitFor(
      () => widgets.at(-1)?.content?.some((line) =>
        line.includes("Last activity: reporting progress")
      ) === true,
      "the adversarial assistant text activity",
    );
    const sanitizationStatus = await statusTool.execute(
      "index-test-sanitization-status",
      { job_id: sanitizationJobId },
      undefined,
      undefined,
      toolContext,
    );
    const sanitizedInspection = sanitizationStatus.content[0]?.text ?? "";
    assert.doesNotMatch(sanitizedInspection, /\u001b/);
    assert.doesNotMatch(sanitizedInspection, /\n\[tool\] forged/);
    assert.match(sanitizedInspection, /\[text\] line one \[tool\] forged x/);
    const inspectedText = sanitizedInspection
      .split("\n")
      .find((line) => line.startsWith("[text] "));
    assert.ok(inspectedText);
    assert.equal(Array.from(inspectedText.slice("[text] ".length)).length, 400);
    assert.ok(inspectedText.endsWith("…"));
    await waitFor(
      () => sentMessages.length === sentBeforeSanitization + 1,
      "the sanitization test completion",
    );
    delete process.env.FAKE_CODEX_RESPONSE_JSON;
    delete process.env.FAKE_CODEX_RESULT_DELAY_SECONDS;

    process.env.FAKE_CODEX_TOOL_COMMAND =
      "npm test -- --runInBand --reporter verbose --coverage";
    process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS = "1";
    process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = "1";
    const sentBeforeLiveActivity = sentMessages.length;
    const liveActivityResult = await tool.execute(
      "index-test-live-activity",
      {
        agent_type: "codex",
        task_name: "Live activity",
        prompt: "Run the tests before responding",
      },
      undefined,
      undefined,
      toolContext,
    );
    const liveActivityJobId = assertRunningJob(liveActivityResult);
    const liveActivityIdentity =
      `Live activity · codex/default/default · ${
        liveActivityJobId.slice(0, 12)
      }`;
    await waitFor(
      () => widgets.at(-1)?.content?.some((line) =>
        line.includes("Last activity")
      ) === true,
      "the live activity widget update",
    );
    assert.deepEqual(widgets.at(-1)?.content, [
      "● Background agents · 1 running",
      `└─ ${liveActivityIdentity}`,
      "   Last activity: shell command: " +
        "`npm test -- --runInBand --reporter verb…`",
    ]);

    const liveStatus = await statusTool.execute(
      "index-test-live-status",
      { job_id: liveActivityJobId },
      undefined,
      undefined,
      toolContext,
    );
    assert.equal(liveStatus.details.status, "running");
    assert.equal(liveStatus.details.jobId, liveActivityJobId);
    const expectedLiveInspection = [
      `Subagent job ${liveActivityJobId}: running`,
      "Task: Live activity",
      "Agent: codex/default/default",
      "Last activity: shell command: " +
        "`npm test -- --runInBand --reporter verb…`",
      "",
      "Activity:",
      "[tool] npm test -- --runInBand --reporter verbose --coverage",
    ].join("\n");
    assert.equal(liveStatus.content[0]?.text, expectedLiveInspection);

    await inspectCommand.handler(liveActivityJobId, commandContext);
    assert.deepEqual(notifications.at(-1), {
      message: expectedLiveInspection,
      type: "info",
    });

    await waitFor(
      () => widgets.at(-1)?.content?.some((line) =>
        line.includes("Last activity: reporting progress")
      ) === true,
      "the live assistant text widget update",
    );
    const textStatus = await statusTool.execute(
      "index-test-live-text-status",
      { job_id: liveActivityJobId },
      undefined,
      undefined,
      toolContext,
    );
    assert.equal(
      textStatus.content[0]?.text,
      [
        `Subagent job ${liveActivityJobId}: running`,
        "Task: Live activity",
        "Agent: codex/default/default",
        "Last activity: reporting progress",
        "",
        "Activity:",
        "[tool] npm test -- --runInBand --reporter verbose --coverage",
        "[text] test response",
      ].join("\n"),
    );
    await waitFor(
      () => sentMessages.length === sentBeforeLiveActivity + 1,
      "the live activity completion",
    );
    await assert.rejects(
      statusTool.execute(
        "index-test-live-status-after-delivery",
        { job_id: liveActivityJobId },
        undefined,
        undefined,
        toolContext,
      ),
      /No active subagent job found/,
    );
    delete process.env.FAKE_CODEX_TOOL_COMMAND;
    delete process.env.FAKE_CODEX_AFTER_TOOL_DELAY_SECONDS;
    delete process.env.FAKE_CODEX_RESULT_DELAY_SECONDS;

    deferMessageDelivery = true;
    const sentBeforeQueuedShutdown = sentMessages.length;
    const queuedShutdownResult = await tool.execute(
      "index-test-shutdown-delivering",
      {
        agent_type: "codex",
        task_name: "Shutdown delivering",
        prompt: "Complete before session shutdown",
      },
      undefined,
      undefined,
      toolContext,
    );
    const queuedShutdownJobId = assertRunningJob(queuedShutdownResult);
    await waitFor(
      () => sentMessages.length === sentBeforeQueuedShutdown + 1,
      "the queued completion before shutdown",
    );

    process.env.FAKE_CODEX_DELAY_SECONDS = "0.2";
    rmSync(startedFile, { force: true });
    const sentBeforeShutdown = sentMessages.length;
    const firstShutdownResult = await tool.execute(
      "index-test-shutdown",
      {
        agent_type: "codex",
        task_name: "Shutdown one",
        prompt: "Wait for session shutdown",
      },
      undefined,
      undefined,
      toolContext,
    );
    const secondShutdownResult = await tool.execute(
      "index-test-shutdown-second",
      {
        agent_type: "codex",
        task_name: "Shutdown two",
        prompt: "Wait for session shutdown too",
      },
      undefined,
      undefined,
      toolContext,
    );
    assertRunningJob(firstShutdownResult);
    assertRunningJob(secondShutdownResult);
    await waitForFile(startedFile);
    await delay(50);
    await shutdownHandlers[0]?.(
      { type: "session_shutdown" },
      toolContext,
    );
    await sessionStartHandlers[0]?.(
      { type: "session_start" },
      { sessionManager: { getBranch: () => [] } },
    );
    await delay(400);
    assert.equal(sentMessages.length, sentBeforeShutdown);
    await assert.rejects(
      statusTool.execute(
        "index-test-status-after-shutdown",
        { job_id: queuedShutdownJobId },
        undefined,
        undefined,
        toolContext,
      ),
      /No active subagent job found/,
    );
    assert.deepEqual(widgets.at(-1), {
      key: "agentshell-jobs",
      content: undefined,
      options: { placement: "aboveEditor" },
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    if (previousArgumentsFile === undefined) {
      delete process.env.FAKE_CODEX_ARGS_FILE;
    } else {
      process.env.FAKE_CODEX_ARGS_FILE = previousArgumentsFile;
    }

    if (previousCwdFile === undefined) {
      delete process.env.FAKE_CODEX_CWD_FILE;
    } else {
      process.env.FAKE_CODEX_CWD_FILE = previousCwdFile;
    }

    if (previousStartedFile === undefined) {
      delete process.env.FAKE_CODEX_STARTED_FILE;
    } else {
      process.env.FAKE_CODEX_STARTED_FILE = previousStartedFile;
    }

    if (previousDelay === undefined) {
      delete process.env.FAKE_CODEX_DELAY_SECONDS;
    } else {
      process.env.FAKE_CODEX_DELAY_SECONDS = previousDelay;
    }

    if (previousError === undefined) {
      delete process.env.FAKE_CODEX_ERROR;
    } else {
      process.env.FAKE_CODEX_ERROR = previousError;
    }

    if (previousRecoveredPiError === undefined) {
      delete process.env.FAKE_PI_RECOVERED_ERROR;
    } else {
      process.env.FAKE_PI_RECOVERED_ERROR = previousRecoveredPiError;
    }

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

    if (previousResultDelay === undefined) {
      delete process.env.FAKE_CODEX_RESULT_DELAY_SECONDS;
    } else {
      process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = previousResultDelay;
    }

    if (previousResponseJson === undefined) {
      delete process.env.FAKE_CODEX_RESPONSE_JSON;
    } else {
      process.env.FAKE_CODEX_RESPONSE_JSON = previousResponseJson;
    }

    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const childTools: CapturedTool[] = [];
  const childPi = {
    registerTool(tool: CapturedTool) {
      childTools.push(tool);
    },
  } as unknown as ExtensionAPI;

  const previousChildMarker = process.env.PI_AGENT_SHELL_CHILD;
  process.env.PI_AGENT_SHELL_CHILD = "1";

  try {
    await subagentsExtension(childPi);
    assert.deepEqual(childTools, []);
  } finally {
    if (previousChildMarker === undefined) {
      delete process.env.PI_AGENT_SHELL_CHILD;
    } else {
      process.env.PI_AGENT_SHELL_CHILD = previousChildMarker;
    }
  }

  process.stderr.write("INDEX_HARNESS_OK\n");
}
