import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  auto_approve?: boolean;
  allowed_tools?: string[];
  disallowed_tools?: string[];
}

export interface RunDetails {
  status: "ok" | "error";
  sessionId?: string;
  outputTokens: number;
}

export interface RunResult {
  output: string;
  details: RunDetails;
}

interface AgentEvent {
  type: string;
  content: string;
  session_id?: string | null;
  output_tokens?: number;
}

interface WorkerMessage {
  kind: string;
  event?: AgentEvent;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAgentShellRuntimeInstalled(): boolean {
  try {
    accessSync(PYTHON, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function invokeWorker(
  request: object,
  signal?: AbortSignal,
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

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
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

  return {
    exitCode,
    stdout,
    stderr,
  };
}

export async function getSupportedAgentTypes(): Promise<string[]> {
  const { exitCode, stdout, stderr } = await invokeWorker({
    operation: "list_agent_types",
  });

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

export async function runAgentShell(
  request: AgentRequest,
  signal?: AbortSignal,
): Promise<RunResult> {
  const { exitCode, stdout, stderr } = await invokeWorker(request, signal);

  const output: string[] = [];
  let status: RunDetails["status"] | undefined;
  let sessionId: string | undefined;
  let outputTokens = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const message = JSON.parse(line) as WorkerMessage;

    if (message.kind !== "event" || message.event === undefined) {
      throw new Error(
        `AgentShell worker emitted unsupported message: ${message.kind}`,
      );
    }

    const event = message.event;

    if (event.type === "text") {
      output.push(event.content);
    }

    if (event.session_id) {
      sessionId = event.session_id;
    }

    if (event.type === "result") {
      status = event.content === "ok" ? "ok" : "error";
      outputTokens = event.output_tokens ?? 0;
    }
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
    },
  };
}
