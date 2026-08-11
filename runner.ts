import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_AGENT_SHELL_LIMITS,
  type AgentShellLimits,
} from "./limits.ts";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const AGENT_SHELL_PROJECT_DIRECTORY = join(
  EXTENSION_DIRECTORY,
  "python",
);

const PYTHON = join(
  AGENT_SHELL_PROJECT_DIRECTORY,
  ".venv",
  "bin",
  "python",
);

const WORKER = join(AGENT_SHELL_PROJECT_DIRECTORY, "worker.py");

export interface AgentRequest {
  agent_type: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: string;
  session_id?: string;
  auto_approve?: boolean;
  allowed_tools?: string[];
  disallowed_tools?: string[];
}

export interface RunDetails {
  status: "running" | "ok" | "error";
  sessionId?: string;
  outputTokens: number;
  warnings: string[];
}

export interface RunResult {
  output: string;
  details: RunDetails;
}

export interface RunActivity {
  type: "text" | "tool_use" | "warning" | "error";
  content: string;
}

export interface RunUpdate extends RunResult {
  activity: RunActivity;
}

interface AgentEvent {
  type: string;
  content: string;
  error?: unknown;
  session_id?: string | null;
  output_tokens?: number;
}

interface WorkerMessage {
  kind: string;
  event?: AgentEvent;
  message?: unknown;
}

interface WorkerProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface AgentTypesMessage {
  kind?: unknown;
  agent_types?: unknown;
}

interface ModelsMessage {
  kind?: unknown;
  message?: unknown;
  models?: unknown;
}

type WorkerLineHandler = (line: string) => void;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatFailure(
  reason: string,
  output: string[],
  partialOutputLabel = "Partial output:",
): string {
  const partialOutput = output.join("\n");

  if (!partialOutput) {
    return reason;
  }

  return [reason, "", partialOutputLabel, partialOutput].join("\n");
}

function formatFailureReasons(reasons: string[]): string {
  const [primary, ...additional] = reasons;

  if (additional.length === 0) {
    return primary ?? "unknown error";
  }

  return [
    primary,
    "",
    "Additional diagnostics:",
    ...additional,
  ].join("\n");
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = "";

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);

    if (bytes + characterBytes > maxBytes) {
      break;
    }

    prefix += character;
    bytes += characterBytes;
  }

  return prefix;
}

function formatLimitFailure(
  subject: string,
  setting: keyof AgentShellLimits,
  maxBytes: number,
): string {
  return [
    `AgentShell ${subject} exceeded the ${maxBytes} byte limit. ` +
      "The agent was stopped.",
    `Increase ${setting} in your AgentShell extension ` +
      "configuration to override it.",
  ].join("\n");
}

function formatOutputLimitFailure(
  maxOutputBytes: number,
  output: string[],
): string {
  const reason = formatLimitFailure(
    "output",
    "maxOutputBytes",
    maxOutputBytes,
  );

  return formatFailure(reason, output, "Partial output (truncated):");
}

function formatModelListLimitFailure(maxOutputBytes: number): string {
  return [
    `AgentShell model list output exceeded the ${maxOutputBytes} byte limit. ` +
      "The model list was not returned.",
    "Increase maxOutputBytes in your AgentShell extension " +
      "configuration to override it.",
  ].join("\n");
}

export function isAgentShellRuntimeInstalled(): boolean {
  try {
    accessSync(PYTHON, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function supportsAgentShellModelDiscovery(): boolean {
  if (!isAgentShellRuntimeInstalled()) {
    return false;
  }

  const check = spawnSync(
    PYTHON,
    [
      "-I",
      "-c",
      "from agent_shell.shell import AgentShell; " +
        "assert hasattr(AgentShell, 'list_models')",
    ],
    { stdio: "ignore", timeout: 5_000 },
  );

  return check.status === 0;
}

async function invokeWorker(
  request: object,
  signal?: AbortSignal,
  onLine?: WorkerLineHandler,
  limits: AgentShellLimits = DEFAULT_AGENT_SHELL_LIMITS,
): Promise<WorkerProcessResult> {
  if (signal?.aborted) {
    throw new Error("aborted");
  }

  const child = spawn(
    PYTHON,
    ["-I", "-u", WORKER],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_AGENT_SHELL_CHILD: "1",
      },
    },
  );

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const pendingLineChunks: Buffer[] = [];
  let protocolBytes = 0;
  let stderrBytes = 0;
  let pendingLineBytes = 0;
  let lineError: unknown;
  let hasLineError = false;

  const stopWorker = (error: unknown) => {
    if (hasLineError) {
      return;
    }

    lineError = error;
    hasLineError = true;
    child.kill("SIGINT");
  };

  const emitLine = () => {
    const lineBuffer = Buffer.concat(
      pendingLineChunks,
      pendingLineBytes,
    );
    const contentLength =
      lineBuffer.at(-1) === 0x0d
        ? lineBuffer.length - 1
        : lineBuffer.length;

    pendingLineChunks.length = 0;
    pendingLineBytes = 0;

    if (onLine === undefined) {
      return;
    }

    try {
      onLine(lineBuffer.toString("utf8", 0, contentLength));
    } catch (error) {
      stopWorker(error);
    }
  };

  const processProtocolChunk = (chunk: Buffer) => {
    let offset = 0;

    while (offset < chunk.length && !hasLineError) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);

      if (
        pendingLineBytes + segment.length >
          limits.maxMessageBytes
      ) {
        stopWorker(new Error(formatLimitFailure(
          "protocol message",
          "maxMessageBytes",
          limits.maxMessageBytes,
        )));
        return;
      }

      if (segment.length > 0) {
        pendingLineChunks.push(segment);
        pendingLineBytes += segment.length;
      }

      if (newline === -1) {
        return;
      }

      emitLine();
      offset = newline + 1;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (hasLineError) {
      return;
    }

    const remainingBytes = limits.maxProtocolBytes - protocolBytes;
    const acceptedBytes = Math.min(chunk.length, remainingBytes);

    if (acceptedBytes > 0) {
      const acceptedChunk = chunk.subarray(0, acceptedBytes);
      stdoutChunks.push(acceptedChunk);
      protocolBytes += acceptedBytes;
      processProtocolChunk(acceptedChunk);
    }

    if (!hasLineError && acceptedBytes < chunk.length) {
      stopWorker(new Error(formatLimitFailure(
        "protocol",
        "maxProtocolBytes",
        limits.maxProtocolBytes,
      )));
    }
  });

  child.stdout.once("end", () => {
    if (!hasLineError && pendingLineBytes > 0) {
      emitLine();
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (hasLineError) {
      return;
    }

    const remainingBytes = limits.maxStderrBytes - stderrBytes;
    const acceptedBytes = Math.min(chunk.length, remainingBytes);

    if (acceptedBytes > 0) {
      stderrChunks.push(chunk.subarray(0, acceptedBytes));
      stderrBytes += acceptedBytes;
    }

    if (acceptedBytes < chunk.length) {
      stopWorker(new Error(formatLimitFailure(
        "stderr",
        "maxStderrBytes",
        limits.maxStderrBytes,
      )));
    }
  });

  const exitCodePromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));

    // A fast startup failure may close stdin before we finish writing.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });

  const abortWorker = () => {
    child.kill("SIGINT");
  };

  if (signal?.aborted) {
    abortWorker();
  } else {
    signal?.addEventListener("abort", abortWorker, { once: true });
  }

  let exitCode: number | null;

  try {
    exitCode = await exitCodePromise;
  } finally {
    signal?.removeEventListener("abort", abortWorker);
  }

  if (signal?.aborted) {
    throw new Error("aborted");
  }

  if (hasLineError) {
    throw lineError;
  }

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks, protocolBytes).toString("utf8"),
    stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
  };
}

export async function getSupportedAgentTypes(
  limits: AgentShellLimits = DEFAULT_AGENT_SHELL_LIMITS,
): Promise<string[]> {
  const { exitCode, stdout, stderr } = await invokeWorker(
    { operation: "list_agent_types" },
    undefined,
    undefined,
    limits,
  );

  if (exitCode !== 0) {
    const diagnostic = stderr.trim();
    const suffix = diagnostic ? `: ${diagnostic}` : "";

    throw new Error(
      `AgentShell worker exited with code ${exitCode}${suffix}`,
    );
  }

  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length !== 1) {
    throw new Error("AgentShell worker returned invalid agent types");
  }

  const message = JSON.parse(lines[0]) as AgentTypesMessage;
  const agentTypes = message.agent_types;

  if (
    message.kind !== "agent_types" ||
    !Array.isArray(agentTypes) ||
    agentTypes.length === 0 ||
    !agentTypes.every(isNonEmptyString)
  ) {
    throw new Error("AgentShell worker returned invalid agent types");
  }

  return agentTypes;
}

export async function getAgentShellModels(
  agentType: string,
  cwd: string,
  signal?: AbortSignal,
  limits: AgentShellLimits = DEFAULT_AGENT_SHELL_LIMITS,
): Promise<string[]> {
  const { exitCode, stdout, stderr } = await invokeWorker(
    {
      operation: "list_models",
      agent_type: agentType,
      cwd,
    },
    signal,
    undefined,
    limits,
  );
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length !== 1) {
    throw new Error("AgentShell worker returned invalid models");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new Error("AgentShell worker returned invalid models");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("AgentShell worker returned invalid models");
  }

  const message = parsed as ModelsMessage;

  if (message.kind === "fatal") {
    if (isNonEmptyString(message.message)) {
      throw new Error(message.message);
    }

    throw new Error("AgentShell worker returned an invalid model error");
  }

  if (exitCode !== 0) {
    const diagnostic = stderr.trim();
    const suffix = diagnostic ? `: ${diagnostic}` : "";

    throw new Error(
      `AgentShell worker exited with code ${exitCode}${suffix}`,
    );
  }

  const models = message.models;

  if (
    message.kind !== "models" ||
    !Array.isArray(models) ||
    !models.every(isNonEmptyString)
  ) {
    throw new Error("AgentShell worker returned invalid models");
  }

  if (Buffer.byteLength(JSON.stringify(models)) > limits.maxOutputBytes) {
    throw new Error(formatModelListLimitFailure(limits.maxOutputBytes));
  }

  return models;
}

export async function runAgentShell(
  request: AgentRequest,
  signal?: AbortSignal,
  onUpdate?: (update: RunUpdate) => void,
  limits: AgentShellLimits = DEFAULT_AGENT_SHELL_LIMITS,
): Promise<RunResult> {
  const output: string[] = [];
  const warnings: string[] = [];
  const failureReasons: string[] = [];
  let status: "ok" | "error" | undefined;
  let sessionId: string | undefined;
  let outputTokens = 0;

  const emitUpdate = (activity: RunActivity) => {
    onUpdate?.({
      output: output.join("\n"),
      activity,
      details: {
        status: "running",
        sessionId,
        outputTokens: 0,
        warnings: [...warnings],
      },
    });
  };

  const handleLine = (line: string) => {
    if (!line.trim()) {
      return;
    }

    const message = JSON.parse(line) as WorkerMessage;

    if (message.kind === "warning") {
      if (!isNonEmptyString(message.message)) {
        throw new Error("AgentShell worker emitted an invalid warning");
      }

      warnings.push(message.message);
      emitUpdate({ type: "warning", content: message.message });
      return;
    }

    if (message.kind === "fatal") {
      if (!isNonEmptyString(message.message)) {
        throw new Error("AgentShell worker emitted an invalid fatal message");
      }

      failureReasons.push(message.message);
      return;
    }

    if (message.kind !== "event" || message.event === undefined) {
      throw new Error(
        `AgentShell worker emitted unsupported message: ${message.kind}`,
      );
    }

    const event = message.event;

    if (event.session_id) {
      sessionId = event.session_id;
    }

    if (event.type === "error" && isNonEmptyString(event.content)) {
      const content = event.content.trim();
      failureReasons.push(content);
      emitUpdate({ type: "error", content });
    }

    if (event.type === "result") {
      status = event.content === "ok" ? "ok" : "error";
      outputTokens = event.output_tokens ?? 0;

      if (status === "error" && failureReasons.length === 0) {
        failureReasons.push(
          isNonEmptyString(event.error)
            ? event.error
            : `${request.agent_type} reported an unsuccessful result`,
        );
      }
    }

    if (event.type === "text") {
      const nextOutput = output.length > 0
        ? `${output.join("\n")}\n${event.content}`
        : event.content;

      if (Buffer.byteLength(nextOutput) > limits.maxOutputBytes) {
        output.length = 0;
        output.push(takeUtf8Prefix(nextOutput, limits.maxOutputBytes));
        throw new Error(
          formatOutputLimitFailure(limits.maxOutputBytes, output),
        );
      }

      output.push(event.content);
      emitUpdate({ type: "text", content: event.content });
    }

    if (event.type === "tool_use" && isNonEmptyString(event.content)) {
      emitUpdate({ type: "tool_use", content: event.content });
    }
  };

  const { exitCode, stderr } = await invokeWorker(
    request,
    signal,
    handleLine,
    limits,
  );

  const runSucceeded = status === "ok" && exitCode === 0;

  if (!runSucceeded && failureReasons.length > 0) {
    throw new Error(formatFailure(
      formatFailureReasons(failureReasons),
      output,
    ));
  }

  if (exitCode !== 0) {
    const diagnostic = stderr.trim();
    const suffix = diagnostic ? `: ${diagnostic}` : "";

    throw new Error(
      `AgentShell worker exited with code ${exitCode}${suffix}`,
    );
  }

  if (status === undefined) {
    throw new Error("AgentShell worker exited without a terminal result");
  }

  return {
    output: output.join("\n"),
    details: {
      status,
      sessionId,
      outputTokens,
      warnings,
    },
  };
}
