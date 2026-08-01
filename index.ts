import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadAgentShellLimits } from "./config.ts";
import {
  JobRegistry,
  type JobSnapshot,
  type JobStatus,
} from "./jobs.ts";
import type { AgentShellLimits } from "./limits.ts";
import {
  AGENT_SHELL_PROJECT_DIRECTORY,
  getSupportedAgentTypes,
  isAgentShellRuntimeInstalled,
  runAgentShell,
  type RunResult,
} from "./runner.ts";

const UV_INSTALL_URL =
  "https://docs.astral.sh/uv/getting-started/installation/";
const OUTPUT_MODE_ENTRY_TYPE = "agentshell-output-mode";
const JOB_RESULT_MESSAGE_TYPE = "agentshell-job-result";
const JOB_WIDGET_KEY = "agentshell-jobs";
const JOB_WIDGET_OPTIONS = { placement: "aboveEditor" as const };

type TerminalJobStatus = Exclude<JobStatus, "running">;

interface JobResultMessageDetails {
  jobId: string;
  status: TerminalJobStatus;
  warnings: string[];
  silent?: boolean;
}

function setupCommand(): string {
  return [
    "uv sync --project",
    `"${AGENT_SHELL_PROJECT_DIRECTORY}"`,
    "--locked",
  ].join(" ");
}

function formatRunOutput(result: RunResult): string {
  const warningOutput = result.details.warnings
    .map((warning) => `Warning: ${warning}`)
    .join("\n");
  const sessionId = result.details.sessionId;
  const sessionOutput = sessionId ? `Session ID: ${sessionId}` : "";

  return [warningOutput, result.output, sessionOutput]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function formatJobLaunch(jobId: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagent job ${jobId} is running.`,
      },
    ],
    details: {
      status: "running" as const,
      jobId,
      outputTokens: 0,
      warnings: [] as string[],
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTerminalMessage(
  jobId: string,
  status: TerminalJobStatus,
  output: string,
): string {
  if (status === "completed") {
    return `Subagent job ${jobId} completed.\n\n${output}`;
  }

  if (status === "cancelled") {
    return `Subagent job ${jobId} was cancelled.\n\n${output}`;
  }

  return `Subagent job ${jobId} failed.\n\n${output}`;
}

function formatJobWidgetRow(job: JobSnapshot, isLast: boolean): string {
  const branch = isLast ? "└─" : "├─";
  const identity = [job.agentType ?? "subagent", job.model]
    .filter((part) => part !== undefined)
    .join(" · ");
  const cancelling = job.status === "cancelled" ? " · cancelling…" : "";

  return `${branch} ${identity} · ${job.id.slice(0, 12)}${cancelling}`;
}

function updateJobWidget(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  jobs: JobRegistry,
): void {
  if (!ctx.hasUI) {
    return;
  }

  const activeJobs = jobs.list().filter((job) =>
    job.status === "running" || job.status === "cancelled"
  );
  if (activeJobs.length === 0) {
    ctx.ui.setWidget(JOB_WIDGET_KEY, undefined, JOB_WIDGET_OPTIONS);
    return;
  }

  const running = activeJobs.filter((job) => job.status === "running").length;
  const cancelling = activeJobs.length - running;
  const counts = [
    running > 0 ? `${running} running` : "",
    cancelling > 0 ? `${cancelling} cancelling` : "",
  ].filter((part) => part.length > 0);
  const glyph = running > 0 ? "●" : "■";
  const header = ctx.ui.theme.fg(
    running > 0 ? "accent" : "warning",
    `${glyph} Background agents · ${counts.join(" · ")}`,
  );
  const visibleJobs = activeJobs.slice(0, 3);
  const hiddenJobs = activeJobs.slice(visibleJobs.length);
  const rows = visibleJobs.map((job, index) => {
    const isLast = hiddenJobs.length === 0 && index === visibleJobs.length - 1;
    const row = formatJobWidgetRow(job, isLast);
    return job.status === "cancelled"
      ? ctx.ui.theme.fg("warning", row)
      : row;
  });

  if (hiddenJobs.length > 0) {
    const hiddenStatus = hiddenJobs.every((job) => job.status === "running")
      ? "running"
      : "active";
    rows.push(
      ctx.ui.theme.fg(
        "dim",
        `└─ +${hiddenJobs.length} more ${hiddenStatus} · /agentshell-jobs`,
      ),
    );
  }

  ctx.ui.setWidget(
    JOB_WIDGET_KEY,
    [header, ...rows],
    JOB_WIDGET_OPTIONS,
  );
}

function sendTerminalMessage(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  jobId: string,
  status: TerminalJobStatus,
  output: string,
  warnings: string[],
  silent: boolean,
  isShuttingDown: () => boolean,
  onJobRemoved: () => void,
): void {
  try {
    if (isShuttingDown()) {
      return;
    }

    pi.sendMessage<JobResultMessageDetails>(
      {
        customType: JOB_RESULT_MESSAGE_TYPE,
        content: formatTerminalMessage(jobId, status, output),
        display: true,
        details: {
          jobId,
          status,
          warnings,
          ...(silent ? { silent: true } : {}),
        },
      },
      {
        triggerTurn: true,
        deliverAs: "followUp",
      },
    );
  } catch (error) {
    if (!isShuttingDown()) {
      process.stderr.write(
        `Could not deliver subagent job ${jobId}: ${errorMessage(error)}\n`,
      );
    }
  } finally {
    jobs.remove(jobId);

    if (!isShuttingDown()) {
      onJobRemoved();
    }
  }
}

function registerJobMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<JobResultMessageDetails>(
    JOB_RESULT_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details;
      const content = typeof message.content === "string"
        ? message.content
        : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

      if (details?.silent && details.status === "completed") {
        const warnings = details.warnings.map((warning) =>
          theme.fg("warning", `Warning: ${warning}`)
        );
        const completed = theme.fg("success", "✓ Completed");
        return new Text([...warnings, completed].join("\n"), 0, 0);
      }

      const color = details?.status === "failed"
        ? "error"
        : details?.status === "cancelled"
        ? "warning"
        : "toolOutput";

      return new Text(theme.fg(color, content), 0, 0);
    },
  );
}

async function registerSubagentTool(
  pi: ExtensionAPI,
  limits: AgentShellLimits,
  jobs: JobRegistry,
  isSilentMode: () => boolean,
  isShuttingDown: () => boolean,
): Promise<void> {
  const agentTypes = await getSupportedAgentTypes(limits);

  registerJobMessageRenderer(pi);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate a task to an AI coding agent in a separate context.",
      "Long-running subagent calls may return `Subagent job <job-id> is running`.",
      "Do not poll the process or run sleep commands. A Job ID is not a session ID.",
      "The extension automatically delivers the result using a follow-up turn.",
      "Continue other work or remain idle until notified.",
      "The real resumable session ID arrives with the completion result.",
    ].join(" "),
    parameters: Type.Object({
      agent_type: StringEnum(agentTypes, {
        description: "AgentShell agent type to run",
      }),
      cwd: Type.Optional(Type.String({
        minLength: 1,
        description:
          "Working directory for the subagent. " +
          "Defaults to Pi's current working directory.",
      })),
      prompt: Type.String({
        description: "Task for the subagent",
      }),
      model: Type.Optional(Type.String({
        minLength: 1,
        description: "Model identifier passed to AgentShell",
      })),
      effort: Type.Optional(Type.String({
        minLength: 1,
        description: "Reasoning effort passed to AgentShell",
      })),
      session_id: Type.Optional(Type.String({
        minLength: 1,
        description:
          "Session ID of an earlier subagent call to resume, " +
          "as reported by that call.",
      })),
      auto_approve: Type.Optional(Type.Boolean({
        description:
          "Allow the subagent to approve tool use automatically. " +
          "Defaults to false.",
      })),
      allowed_tools: Type.Optional(Type.Array(
        Type.String({ minLength: 1 }),
        {
          minItems: 1,
          description:
            "Tool names the subagent may use, when supported",
        },
      )),
      disallowed_tools: Type.Optional(Type.Array(
        Type.String({ minLength: 1 }),
        {
          minItems: 1,
          description:
            "Tool names the subagent must not use, when supported",
        },
      )),
    }),

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("Subagent ")) +
        theme.fg("accent", args.agent_type);

      if (args.model) {
        text += theme.fg("muted", ` · model: ${args.model}`);
      }

      if (args.effort) {
        text += theme.fg("muted", ` · effort: ${args.effort}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, context) {
      const output = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const color = context.isError ? "error" : "toolOutput";

      return new Text(theme.fg(color, output), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const silent = isSilentMode();
      const job = jobs.start(
        (signal) =>
          runAgentShell(
            {
              agent_type: params.agent_type,
              cwd: params.cwd ?? ctx.cwd,
              prompt: params.prompt,
              model: params.model,
              effort: params.effort,
              session_id: params.session_id,
              auto_approve: params.auto_approve,
              allowed_tools: params.allowed_tools,
              disallowed_tools: params.disallowed_tools,
            },
            signal,
            undefined,
            limits,
          ),
        {
          agentType: params.agent_type,
          model: params.model,
        },
      );

      updateJobWidget(ctx, jobs);

      void job.completion.then(
        (result) => {
          const status = jobs.get(job.id)?.status === "cancelled"
            ? "cancelled"
            : "completed";
          const output = status === "cancelled"
            ? "The worker stopped after cancellation."
            : formatRunOutput(result);

          sendTerminalMessage(
            pi,
            jobs,
            job.id,
            status,
            output,
            result.details.warnings,
            silent,
            isShuttingDown,
            () => updateJobWidget(ctx, jobs),
          );
        },
        (error: unknown) => {
          const status = jobs.get(job.id)?.status === "cancelled"
            ? "cancelled"
            : "failed";

          sendTerminalMessage(
            pi,
            jobs,
            job.id,
            status,
            errorMessage(error),
            [],
            silent,
            isShuttingDown,
            () => updateJobWidget(ctx, jobs),
          );
        },
      );

      return formatJobLaunch(job.id);
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel subagent",
    description: "Cancel a running AgentShell subagent job by ID",
    parameters: Type.Object({
      job_id: Type.String({
        minLength: 1,
        description: "Job ID returned by the subagent tool",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!jobs.cancel(params.job_id)) {
        throw new Error(
          `No running subagent job found with ID ${params.job_id}.`,
        );
      }

      updateJobWidget(ctx, jobs);

      return {
        content: [
          {
            type: "text" as const,
            text: `Subagent job ${params.job_id} cancelled.`,
          },
        ],
        details: {
          status: "cancelled" as const,
          jobId: params.job_id,
          outputTokens: 0,
          warnings: [] as string[],
        },
      };
    },
  });
}

export default async function subagentsExtension(
  pi: ExtensionAPI,
): Promise<void> {
  if (process.env.PI_AGENT_SHELL_CHILD === "1") {
    return;
  }

  const jobs = new JobRegistry();
  let shuttingDown = false;
  let silentMode = false;

  pi.on("session_start", (_event, ctx) => {
    shuttingDown = false;
    silentMode = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === OUTPUT_MODE_ENTRY_TYPE &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "silent" in entry.data &&
        typeof entry.data.silent === "boolean"
      ) {
        silentMode = entry.data.silent;
      }
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    shuttingDown = true;
    jobs.cancelAll();

    if (ctx.hasUI) {
      ctx.ui.setWidget(JOB_WIDGET_KEY, undefined, JOB_WIDGET_OPTIONS);
    }
  });

  pi.registerCommand("agentshell-silent", {
    description: "Toggle display of subagent responses",
    handler: async (_args, ctx) => {
      silentMode = !silentMode;
      pi.appendEntry(OUTPUT_MODE_ENTRY_TYPE, { silent: silentMode });
      ctx.ui.notify(
        silentMode
          ? "Subagent responses are now hidden."
          : "Subagent responses are now visible.",
        "info",
      );
    },
  });

  pi.registerCommand("agentshell-jobs", {
    description: "List active AgentShell subagent jobs",
    handler: async (_args, ctx) => {
      const activeJobs = jobs.list();

      if (activeJobs.length === 0) {
        ctx.ui.notify("No active subagent jobs.", "info");
        return;
      }

      ctx.ui.notify(
        activeJobs.map((job) => `${job.id}: ${job.status}`).join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("agentshell-cancel", {
    description: "Cancel an active AgentShell subagent job by ID",
    handler: async (args, ctx) => {
      const jobId = args.trim();

      if (jobId.length === 0) {
        ctx.ui.notify("Usage: /agentshell-cancel <job-id>", "warning");
        return;
      }

      const cancelled = jobs.cancel(jobId);

      if (cancelled) {
        updateJobWidget(ctx, jobs);
      }

      ctx.ui.notify(
        cancelled
          ? `Subagent job ${jobId} cancelled.`
          : `No running subagent job found with ID ${jobId}.`,
        cancelled ? "info" : "warning",
      );
    },
  });

  const limits = loadAgentShellLimits(getAgentDir());
  const registerTool = () =>
    registerSubagentTool(
      pi,
      limits,
      jobs,
      () => silentMode,
      () => shuttingDown,
    );

  if (isAgentShellRuntimeInstalled()) {
    await registerTool();
    return;
  }

  let setupAttempted = false;

  pi.on("session_start", async (_event, ctx) => {
    if (setupAttempted) {
      return;
    }

    setupAttempted = true;
    const command = setupCommand();

    if (!ctx.hasUI) {
      process.stderr.write(
        `AgentShell runtime is missing. Run: ${command}\n`,
      );
      return;
    }

    const uvCheck = await pi.exec(
      "uv",
      ["--version"],
      { timeout: 5_000 },
    );

    if (uvCheck.code !== 0) {
      ctx.ui.notify(
        [
          "`uv` is required to set up the AgentShell runtime.",
          "Install it from:",
          UV_INSTALL_URL,
          "Then restart Pi or run /reload.",
        ].join("\n"),
        "error",
      );
      return;
    }

    const confirmed = await ctx.ui.confirm(
      "Set up AgentShell runtime?",
      [
        "The subagent extension needs its locked Python dependency.",
        "",
        `Run: ${command}`,
        "",
        "This may download Python and the audited AgentShell dependency.",
      ].join("\n"),
    );

    if (!confirmed) {
      ctx.ui.notify(
        `AgentShell was not installed. Run manually:\n${command}`,
        "warning",
      );
      return;
    }

    ctx.ui.notify("Installing the AgentShell runtime...", "info");

    const setup = await pi.exec(
      "uv",
      [
        "sync",
        "--project",
        AGENT_SHELL_PROJECT_DIRECTORY,
        "--locked",
      ],
    );

    if (setup.code !== 0) {
      const diagnostic =
        setup.stderr.trim() ||
        setup.stdout.trim() ||
        `uv exited with code ${setup.code}`;

      ctx.ui.notify(
        `AgentShell setup failed:\n${diagnostic}`,
        "error",
      );
      return;
    }

    try {
      await registerTool();
      ctx.ui.notify("The subagent tool is ready.", "info");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      ctx.ui.notify(
        `AgentShell was installed but could not start:\n${message}`,
        "error",
      );
    }
  });
}
