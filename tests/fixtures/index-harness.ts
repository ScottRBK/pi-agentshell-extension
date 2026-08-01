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
    outputTokens: number;
    warnings: string[];
  };
}

interface CapturedCommand {
  name: string;
  handler(args: string, context: CommandContext): Promise<void>;
}

interface CommandContext {
  ui: {
    notify(message: string, type: string): void;
  };
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

type SessionShutdownHandler = (
  event: { type: "session_shutdown" },
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

function assertRunningJob(result: CapturedResult): string {
  assert.equal(result.details.status, "running");
  assert.match(
    result.details.jobId ?? "",
    /^job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(result.content[0]?.text ?? "", /running/i);

  return result.details.jobId as string;
}

export default async function indexHarness(): Promise<void> {
  const commands: CapturedCommand[] = [];
  const sentMessages: SentMessage[] = [];
  const shutdownHandlers: SessionShutdownHandler[] = [];
  const tools: CapturedTool[] = [];

  const fakePi = {
    registerCommand(name: string, command: Omit<CapturedCommand, "name">) {
      commands.push({ name, ...command });
    },
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
    registerMessageRenderer() {},
    on(event: string, handler: SessionShutdownHandler) {
      if (event === "session_shutdown") {
        shutdownHandlers.push(handler);
      }
    },
    appendEntry() {},
    sendMessage(message: CapturedMessage, options: SentMessage["options"]) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);

  assert.equal(tools.length, 2);
  assert.equal(
    shutdownHandlers.length,
    1,
    "the extension must cancel outstanding jobs on session shutdown",
  );

  const tool = tools.find(({ name }) => name === "subagent");
  const cancelTool = tools.find(({ name }) => name === "subagent_cancel");
  assert.ok(tool);
  assert.ok(cancelTool);
  assert.match(tool.description, /Long-running subagent calls may return/i);
  assert.match(tool.description, /Do not poll/i);
  assert.match(tool.description, /sleep commands/i);
  assert.match(tool.description, /A Job ID is not a session ID/i);
  assert.match(tool.description, /automatically delivers.*follow-up turn/i);
  assert.match(tool.description, /Continue other work or remain idle/i);
  assert.match(tool.description, /resumable session ID.*completion result/i);
  assert.deepEqual(cancelTool.parameters.required, ["job_id"]);
  assert.equal(cancelTool.parameters.properties?.job_id?.type, "string");
  assert.equal(cancelTool.parameters.properties?.job_id?.minLength, 1);

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
          prompt: "Return too much output",
        },
        undefined,
        undefined,
        { cwd: PYTHON_DIR },
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

  assert.deepEqual(tool.parameters.required, ["agent_type", "prompt"]);
  assert.equal(tool.parameters.properties?.cwd?.type, "string");
  assert.equal(tool.parameters.properties?.model?.type, "string");
  assert.equal(tool.parameters.properties?.model?.minLength, 1);
  assert.equal(tool.parameters.properties?.effort?.type, "string");
  assert.equal(tool.parameters.properties?.effort?.minLength, 1);
  assert.equal(tool.parameters.properties?.session_id?.type, "string");
  assert.equal(tool.parameters.properties?.session_id?.minLength, 1);
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

  const renderCall = tool.renderCall;
  assert.ok(renderCall);

  const theme: CapturedTheme = {
    bold: (text) => text,
    fg: (_color, text) => text,
  };

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
  process.env.PATH = FAKE_BIN;
  process.env.FAKE_CODEX_ARGS_FILE = argumentsFile;
  process.env.FAKE_CODEX_CWD_FILE = cwdFile;

  try {
    const updates: CapturedResult[] = [];
    const notifications: Array<{ message: string; type: string }> = [];
    const commandContext: CommandContext = {
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    };
    const jobsCommand = commands.find(({ name }) => name === "agentshell-jobs");
    const cancelCommand = commands.find(({ name }) => name === "agentshell-cancel");
    assert.ok(jobsCommand, "the extension must register /agentshell-jobs");
    assert.ok(cancelCommand, "the extension must register /agentshell-cancel");

    process.env.FAKE_CODEX_DELAY_SECONDS = "1";
    const submittedAt = Date.now();
    const defaultResult = await tool.execute(
      "index-test-default-cwd",
      {
        agent_type: "codex",
        prompt: "Return a test response",
      },
      undefined,
      (update: CapturedResult) => updates.push(update),
      { cwd: PYTHON_DIR },
    );

    const defaultJobId = assertRunningJob(defaultResult);
    assert.ok(Date.now() - submittedAt < 500, "subagent submission waited for completion");
    assert.deepEqual(updates, []);
    await waitForFile(cwdFile);
    assert.equal(
      readFileSync(cwdFile, "utf8").trim(),
      PYTHON_DIR,
    );

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", new RegExp(defaultJobId));
    assert.match(notifications.at(-1)?.message ?? "", /running/i);

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

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", /no .*jobs/i);

    rmSync(cwdFile, { force: true });
    const overriddenResult = await tool.execute(
      "index-test-overridden-cwd",
      {
        agent_type: "codex",
        cwd: overriddenCwd,
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
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
        model: "test-model",
        effort: "high",
        auto_approve: true,
        allowed_tools: ["Read"],
        disallowed_tools: ["web_search"],
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
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
        prompt: "Continue the task",
        session_id: "existing-session",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
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
        prompt: "Fail after returning partial output",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );
    assertRunningJob(failedResult);
    await waitFor(
      () => sentMessages.length === 5,
      "the failed AgentShell completion",
    );
    assert.match(sentMessages.at(-1)?.message.content ?? "", /fake agent failed/);
    assert.equal(sentMessages.at(-1)?.message.details?.status, "failed");
    delete process.env.FAKE_CODEX_ERROR;

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", /no .*jobs/i);

    process.env.FAKE_CODEX_STARTED_FILE = startedFile;
    process.env.FAKE_CODEX_DELAY_SECONDS = "2";

    const cancelledResult = await tool.execute(
      "index-test-cancelled",
      {
        agent_type: "codex",
        prompt: "Wait for cancellation",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );

    const cancelledJobId = assertRunningJob(cancelledResult);
    await waitForFile(startedFile);
    const cancellation = await cancelTool.execute(
      "index-test-agent-cancel",
      { job_id: cancelledJobId },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );
    assert.equal(cancellation.details.status, "cancelled");
    assert.equal(cancellation.details.jobId, cancelledJobId);
    assert.match(cancellation.content[0]?.text ?? "", /cancelled/i);
    await assert.rejects(
      cancelTool.execute(
        "index-test-agent-cancel-again",
        { job_id: cancelledJobId },
        undefined,
        undefined,
        { cwd: PYTHON_DIR },
      ),
      /No running subagent job found/,
    );
    await assert.rejects(
      cancelTool.execute(
        "index-test-agent-cancel-unknown",
        { job_id: "job-unknown" },
        undefined,
        undefined,
        { cwd: PYTHON_DIR },
      ),
      /No running subagent job found/,
    );
    await waitFor(
      () => sentMessages.length === 6,
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
        prompt: "Wait for slash-command cancellation",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );
    const commandCancelledJobId = assertRunningJob(commandCancelledResult);
    await waitForFile(startedFile);
    await cancelCommand.handler(commandCancelledJobId, commandContext);
    assert.equal(notifications.at(-1)?.type, "info");
    assert.match(notifications.at(-1)?.message ?? "", /cancelled/i);
    await waitFor(
      () => sentMessages.length === 7,
      "the slash-command cancelled AgentShell completion",
    );
    assert.equal(sentMessages.at(-1)?.message.details?.status, "cancelled");

    await jobsCommand.handler("", commandContext);
    assert.match(notifications.at(-1)?.message ?? "", /no .*jobs/i);

    process.env.FAKE_CODEX_STARTED_FILE = startedFile;
    process.env.FAKE_CODEX_DELAY_SECONDS = "0.2";
    rmSync(startedFile, { force: true });
    const sentBeforeShutdown = sentMessages.length;
    const firstShutdownResult = await tool.execute(
      "index-test-shutdown",
      {
        agent_type: "codex",
        prompt: "Wait for session shutdown",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );
    const secondShutdownResult = await tool.execute(
      "index-test-shutdown-second",
      {
        agent_type: "codex",
        prompt: "Wait for session shutdown too",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );
    assertRunningJob(firstShutdownResult);
    assertRunningJob(secondShutdownResult);
    await waitForFile(startedFile);
    await delay(50);
    await shutdownHandlers[0]?.({ type: "session_shutdown" }, {});
    await delay(400);
    assert.equal(sentMessages.length, sentBeforeShutdown);
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
