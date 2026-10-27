import { join, resolve } from "node:path";
import { inspect, isDeepStrictEqual, stripVTControlCharacters } from "node:util";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
  loadAgentShellAgentFile,
  loadAgentShellConfig,
  loadAgentShellRosterFile,
  resolvePromptSkillFiles,
  resolveSessionResources,
  setRosterEnabled,
  type AgentShellInteractiveConfig,
  type AgentShellRosterConfig,
  type AgentShellRosterRole,
} from "./config.ts";
import {
  JobRegistry,
  type JobActivity,
  type JobSnapshot,
  type JobStatus,
} from "./jobs.ts";
import type { AgentShellLimits } from "./limits.ts";
import {
  AGENT_SHELL_PROJECT_DIRECTORY,
  agentShellSetupCommand,
  closeAgentShellWorkers,
  getAgentShellModels,
  getSupportedAgentTypes,
  inheritedAgentShellDelegation,
  isAgentShellRuntimeInstalled,
  runAgentShell,
  supportsAgentShellInteractive,
  supportsAgentShellModelDiscovery,
  type AgentShellDelegation,
  type AgentRequest,
  type RunResult,
} from "./runner.ts";

const UV_INSTALL_URL =
  "https://docs.astral.sh/uv/getting-started/installation/";
const LAUNCH_ENTRY_TYPE = "agentshell-session-launch";
const OUTPUT_MODE_ENTRY_TYPE = "agentshell-output-mode";
const JOB_RESULT_MESSAGE_TYPE = "agentshell-job-result";
const JOB_WIDGET_KEY = "agentshell-jobs";
const JOB_WIDGET_OPTIONS = { placement: "aboveEditor" as const };
const MAX_WIDGET_ACTIVITY_CHARACTERS = 40;
const MAX_INSPECTION_ACTIVITY_ENTRIES = 20;
const MAX_INSPECTION_ENTRY_CHARACTERS = 400;
const MAX_ERROR_DIAGNOSTIC_CHARACTERS = 4_000;
const UNKNOWN_ERROR_MESSAGE = "Unknown error (no readable message).";
const RESUME_SESSION_GUIDANCE = [
  "Omit `resume_session_id` for a new session.",
  "If the tool-call interface requires this property, use `null` for a new session.",
  "For a resumed session, the value must come from an earlier successful " +
    "subagent result.",
  "Do not pass `new`, a background Job ID, or a newly generated UUID.",
  "For a known selected session, omit repeated launch settings to reuse its recorded selection.",
  "Approval/tool controls are call-only: omitted auto_approve is false; " +
    "omitted tool lists are not reused.",
  "Roster-defined model/effort stay fixed; ad-hoc model/effort and " +
    "operational controls may change.",
  "Do not resume an active session, including one already being resumed; " +
    "concurrent resumes are not prevented.",
].join(" ");

interface SavedLaunch {
  version: 1;
  sessionId: string;
  request: Omit<AgentRequest, "prompt" | "session_id">;
  rosterSource?: string;
  role?: AgentShellRosterRole;
  childRoster?: AgentShellRosterConfig;
}

function launchKey(launch: SavedLaunch): string {
  return JSON.stringify([launch.request.agent_type, launch.sessionId]);
}

function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type TerminalJobStatus = Exclude<JobStatus, "running">;

interface JobResultMessageDetails {
  jobId: string;
  status: TerminalJobStatus;
  warnings: string[];
  silent?: boolean;
}

interface PendingTerminalMessage {
  jobId: string;
  status: TerminalJobStatus;
  output: string;
  warnings: string[];
  silent: boolean;
}

interface TerminalDeliveryState {
  deliveries: Map<string, TerminalJobStatus>;
  pendingMessages: PendingTerminalMessage[];
  isParentAgentActive: () => boolean;
  isShuttingDown: () => boolean;
}

interface SubagentRuntime {
  limits: AgentShellLimits;
  interactiveConfig: AgentShellInteractiveConfig;
  modelDiscoverySupported: boolean;
  interactiveSupported: boolean;
  delegation: AgentShellDelegation;
}

interface LaunchSelectionState {
  getRoster: () => AgentShellRosterConfig;
  rosterSource: string;
  savedLaunches: Map<string, SavedLaunch>;
  retainedLaunches: Set<string>;
}

interface InteractiveLaunchSettings {
  interactive: boolean;
  stay_open: boolean;
  inactivity_timeout: number;
  inactivity_enabled: boolean;
}

function resolveInteractiveLaunchSettings(
  params: Partial<InteractiveLaunchSettings>,
  config: AgentShellInteractiveConfig,
): InteractiveLaunchSettings {
  const interactive = params.interactive ?? config.enabled;

  return {
    interactive,
    stay_open: interactive
      ? params.stay_open ?? config.stay_open
      : false,
    inactivity_timeout: params.inactivity_timeout ??
      config.inactivity_timeout,
    inactivity_enabled: params.inactivity_enabled ??
      config.inactivity_enabled,
  };
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
        text: `Subagent job ${jobId} started.`,
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

function readErrorMessage(error: unknown): string | undefined {
  try {
    switch (typeof error) {
      case "string":
        return error;
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
        return String(error);
      case "undefined":
        return "undefined";
      case "object":
      case "function": {
        if (error === null) return "null";
        // Even Error.message can be a throwing getter or proxy trap.
        const message: unknown = Reflect.get(error, "message");
        return typeof message === "string" ? message : undefined;
      }
    }
  } catch {
    return undefined;
  }
}

function localErrorDiagnostic(error: unknown): string {
  const message = readErrorMessage(error);
  if (message !== undefined) return message;

  // Debugging only, not redaction. Never send arbitrary inspected fields to the model.
  try {
    const detail = inspect(error, {
      depth: 2, maxArrayLength: 10, maxStringLength: 500,
      customInspect: false, getters: false, colors: false,
    });
    const safe = stripVTControlCharacters(detail)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    return safe.length > MAX_ERROR_DIAGNOSTIC_CHARACTERS
      ? `${safe.slice(0, MAX_ERROR_DIAGNOSTIC_CHARACTERS - 1)}…` : safe;
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
}

function logLocalError(context: string, error: unknown): void {
  try {
    process.stderr.write(`${context}: ${localErrorDiagnostic(error)}\n`);
  } catch {
    // Diagnostics are best-effort and must not prevent job delivery or cleanup.
  }
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

function formatJobWidgetRow(
  job: JobSnapshot,
  isLast: boolean,
  deliveryStatus?: TerminalJobStatus,
): string {
  const branch = isLast ? "└─" : "├─";
  const taskName = job.taskName ?? "Subagent";
  const runtime = [
    job.agentType ?? "subagent",
    job.model ?? "default",
    job.effort ?? "default",
  ].join("/");
  let status = "";
  if (deliveryStatus !== undefined) {
    status = ` · ${deliveryStatus} · delivering…`;
  } else if (job.status === "cancelled") {
    status = " · cancelling…";
  }

  return `${branch} ${taskName} · ${runtime} · ${job.id.slice(0, 12)}${status}`;
}

function cleanActivityText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateActivityText(value: string, maxCharacters: number): string {
  const characters = Array.from(value);

  if (characters.length <= maxCharacters) {
    return value;
  }

  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function describeToolActivity(job: JobSnapshot, content: string): string {
  const cleaned = cleanActivityText(content);

  if (cleaned.length === 0) {
    return "using a tool";
  }

  const normalized = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
  const knownDescriptions: Record<string, string> = {
    read: "reading a file",
    view: "reading a file",
    edit: "editing a file",
    write: "editing a file",
    notebookedit: "editing a notebook",
    grep: "searching the codebase",
    glob: "searching the codebase",
    websearch: "searching the web",
    webfetch: "fetching a web page",
    bash: "shell command",
    shell: "shell command",
  };
  const known = knownDescriptions[normalized];

  if (known !== undefined) {
    return known;
  }

  const shortContent = truncateActivityText(
    cleaned,
    MAX_WIDGET_ACTIVITY_CHARACTERS,
  );

  if (
    job.agentType === "codex" ||
    job.agentType === "cursor" ||
    /[\s|&;<>]/.test(cleaned)
  ) {
    return `shell command: \`${shortContent}\``;
  }

  return `using ${shortContent}`;
}

function describeLatestActivity(job: JobSnapshot): string | undefined {
  const activity = job.latestActivity;

  if (activity === undefined) {
    return undefined;
  }

  if (activity.type === "tool_use") {
    return describeToolActivity(job, activity.content);
  }

  if (activity.type === "text") {
    return "reporting progress";
  }

  return activity.type === "warning"
    ? "warning reported"
    : "error reported";
}

function formatActivityEntry(activity: JobActivity): string {
  const label = activity.type === "tool_use" ? "tool" : activity.type;
  const cleaned = cleanActivityText(activity.content);
  const content = truncateActivityText(
    cleaned,
    MAX_INSPECTION_ENTRY_CHARACTERS,
  );

  return `[${label}] ${content || "(no displayable content)"}`;
}

function formatJobInspection(
  job: JobSnapshot,
  isDelivering = false,
): string {
  const runtime = [
    job.agentType ?? "subagent",
    job.model ?? "default",
    job.effort ?? "default",
  ].join("/");

  if (isDelivering) {
    return [
      `Subagent job ${job.id}: delivering`,
      `Task: ${job.taskName ?? "Subagent"}`,
      `Agent: ${runtime}`,
      "Final result is waiting for delivery.",
    ].join("\n");
  }

  const latest = describeLatestActivity(job) ?? "waiting for activity";
  const activity = job.activity
    ?.slice(-MAX_INSPECTION_ACTIVITY_ENTRIES)
    .map(formatActivityEntry) ?? [];

  return [
    `Subagent job ${job.id}: ${job.status}`,
    `Task: ${job.taskName ?? "Subagent"}`,
    `Agent: ${runtime}`,
    `Last activity: ${latest}`,
    "",
    "Activity:",
    ...(activity.length > 0 ? activity : ["No activity reported yet."]),
  ].join("\n");
}

function formatJobListEntry(
  job: JobSnapshot,
  isDelivering: boolean,
): string {
  const status = isDelivering ? "delivering" : job.status;
  const details = [
    job.taskName ?? "Subagent",
    job.agentType ?? "subagent",
    job.model ?? "default",
    `effort: ${job.effort ?? "default"}`,
  ].join(" · ");
  const latest = isDelivering ? undefined : describeLatestActivity(job);

  return [
    `${job.id}: ${status}`,
    `  ${details}`,
    ...(latest === undefined ? [] : [`  Last activity: ${latest}`]),
  ].join("\n");
}

function formatJobLookupFailure(
  jobId: string,
  jobs: JobRegistry,
): string {
  const activeJobIds = jobs.list().map((job) => `- ${job.id}`);
  const activeJobs = activeJobIds.length === 0
    ? "No subagent jobs are currently active."
    : ["Active subagent jobs:", ...activeJobIds].join("\n");

  return [
    `No active subagent job found with ID ${jobId}.`,
    activeJobs,
  ].join("\n\n");
}

function formatCancellationFailure(
  jobId: string,
  jobs: JobRegistry,
): string {
  const runningJobIds = jobs.list()
    .filter((job) => job.status === "running")
    .map((job) => `- ${job.id}`);
  const runningJobs = runningJobIds.length === 0
    ? "No subagent jobs are currently running."
    : ["Running subagent jobs:", ...runningJobIds].join("\n");

  return [
    `No running subagent job found with ID ${jobId}.`,
    runningJobs,
  ].join("\n\n");
}

function updateJobWidget(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  jobs: JobRegistry,
  deliveries: ReadonlyMap<string, TerminalJobStatus>,
): void {
  if (!ctx.hasUI) {
    return;
  }

  const activeJobs = jobs.list();
  if (activeJobs.length === 0) {
    ctx.ui.setWidget(JOB_WIDGET_KEY, undefined, JOB_WIDGET_OPTIONS);
    return;
  }

  const running = activeJobs.filter((job) => job.status === "running").length;
  const cancelling = activeJobs.filter((job) =>
    job.status === "cancelled" && !deliveries.has(job.id)
  ).length;
  const delivering = activeJobs.filter((job) => deliveries.has(job.id)).length;
  const counts = [
    running > 0 ? `${running} running` : "",
    cancelling > 0 ? `${cancelling} cancelling` : "",
    delivering > 0 ? `${delivering} delivering` : "",
  ].filter((part) => part.length > 0);
  let glyph = "◆";
  if (running > 0) {
    glyph = "●";
  } else if (cancelling > 0) {
    glyph = "■";
  }
  const header = ctx.ui.theme.fg(
    cancelling > 0 && running === 0 ? "warning" : "accent",
    `${glyph} Background agents · ${counts.join(" · ")}`,
  );
  const visibleJobs = activeJobs.slice(0, 3);
  const hiddenJobs = activeJobs.slice(visibleJobs.length);
  const rows: string[] = [];

  visibleJobs.forEach((job, index) => {
    const isLast = hiddenJobs.length === 0 && index === visibleJobs.length - 1;
    const deliveryStatus = deliveries.get(job.id);
    const row = formatJobWidgetRow(job, isLast, deliveryStatus);
    let styledRow = row;
    if (deliveryStatus === "completed") {
      styledRow = ctx.ui.theme.fg("success", row);
    } else if (deliveryStatus === "failed") {
      styledRow = ctx.ui.theme.fg("error", row);
    } else if (job.status === "cancelled") {
      styledRow = ctx.ui.theme.fg("warning", row);
    }

    rows.push(styledRow);

    const latest = describeLatestActivity(job);
    if (latest !== undefined && deliveryStatus === undefined) {
      const continuation = isLast ? "  " : "│ ";
      rows.push(
        ctx.ui.theme.fg(
          "dim",
          `${continuation} Last activity: ${latest}`,
        ),
      );
    }
  });

  if (hiddenJobs.length > 0) {
    let hiddenStatus = "active";
    if (hiddenJobs.every((job) => job.status === "running")) {
      hiddenStatus = "running";
    } else if (hiddenJobs.every((job) => deliveries.has(job.id))) {
      hiddenStatus = "delivering";
    }
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

function safelyUpdateJobWidget(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  jobs: JobRegistry,
  deliveries: ReadonlyMap<string, TerminalJobStatus>,
): void {
  try {
    updateJobWidget(ctx, jobs, deliveries);
  } catch (error) {
    logLocalError("Could not update AgentShell job widget", error);
  }
}

function deliverTerminalMessage(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  message: PendingTerminalMessage,
  isShuttingDown: () => boolean,
  deliveries: Map<string, TerminalJobStatus>,
  onWidgetChange: () => void,
): void {
  const { jobId, status, output, warnings, silent } = message;

  if (isShuttingDown() || jobs.get(jobId) === undefined) {
    deliveries.delete(jobId);
    jobs.remove(jobId);
    return;
  }

  try {
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
    onWidgetChange();
  } catch (error) {
    logLocalError(`Could not deliver subagent job ${jobId}`, error);
    deliveries.delete(jobId);
    jobs.remove(jobId);
    onWidgetChange();
  }
}

function sendTerminalMessage(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  message: PendingTerminalMessage,
  delivery: TerminalDeliveryState,
  onWidgetChange: () => void,
): void {
  const { isShuttingDown, isParentAgentActive, deliveries, pendingMessages } = delivery;
  if (isShuttingDown() || jobs.get(message.jobId) === undefined) {
    jobs.remove(message.jobId);
    return;
  }

  deliveries.set(message.jobId, message.status);

  if (isParentAgentActive()) {
    pendingMessages.push(message);
    onWidgetChange();
    return;
  }

  deliverTerminalMessage(
    pi,
    jobs,
    message,
    isShuttingDown,
    deliveries,
    onWidgetChange,
  );
}

function flushPendingTerminalMessages(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  pendingMessages: PendingTerminalMessage[],
  isShuttingDown: () => boolean,
  deliveries: Map<string, TerminalJobStatus>,
  onWidgetChange: () => void,
): void {
  const messages = pendingMessages.splice(0);

  for (const message of messages) {
    deliverTerminalMessage(
      pi,
      jobs,
      message,
      isShuttingDown,
      deliveries,
      onWidgetChange,
    );
  }
}

function registerJobDeliveryHandler(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  deliveries: Map<string, TerminalJobStatus>,
): void {
  pi.on("message_start", (event, ctx) => {
    const message = event.message;

    if (
      message.role !== "custom" ||
      message.customType !== JOB_RESULT_MESSAGE_TYPE ||
      typeof message.details !== "object" ||
      message.details === null ||
      !("jobId" in message.details) ||
      typeof message.details.jobId !== "string"
    ) {
      return;
    }

    const jobId = message.details.jobId;

    if (deliveries.delete(jobId)) {
      jobs.remove(jobId);
      safelyUpdateJobWidget(ctx, jobs, deliveries);
    }
  });
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

      let color: "error" | "warning" | "toolOutput" = "toolOutput";
      if (details?.status === "failed") {
        color = "error";
      } else if (details?.status === "cancelled") {
        color = "warning";
      }

      return new Text(theme.fg(color, content), 0, 0);
    },
  );
}

function registerSubagentModelsTool(
  pi: ExtensionAPI,
  agentTypes: string[],
  limits: AgentShellLimits,
): void {
  pi.registerTool({
    name: "subagent_list_models",
    label: "List subagent models",
    description: [
      "List the exact model selectors advertised by an AgentShell agent.",
      "Pass a returned selector unchanged to the subagent tool's model parameter.",
      "An empty list is valid and does not prove a model can run.",
    ].join(" "),
    parameters: Type.Object({
      agent_type: StringEnum(agentTypes, {
        description: "AgentShell agent type to inspect",
      }),
      cwd: Type.Optional(Type.String({
        minLength: 1,
        description:
          "Working directory used for workspace-aware discovery. " +
          "Defaults to Pi's current working directory.",
      })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const models = await getAgentShellModels(
        params.agent_type,
        params.cwd ?? ctx.cwd,
        signal,
        limits,
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(models),
        }],
        details: {
          status: "ok" as const,
          agentType: params.agent_type,
          models,
          outputTokens: 0,
          warnings: [] as string[],
        },
      };
    },
  });
}

function registerSubagentStatusTool(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  deliveries: ReadonlyMap<string, TerminalJobStatus>,
  isSilentMode: () => boolean,
): void {
  pi.registerTool({
    name: "subagent_status",
    label: "Inspect subagent",
    description: [
      "Inspect the current status and recent activity of an active subagent job.",
      "Use this when progress is useful; do not repeatedly poll the job.",
      "Activity is held only in memory and is removed after final delivery.",
    ].join(" "),
    parameters: Type.Object({
      job_id: Type.String({
        minLength: 1,
        description: "Job ID returned by the subagent tool",
      }),
    }),

    async execute(_toolCallId, params) {
      const job = jobs.get(params.job_id);

      if (job === undefined) {
        throw new Error(formatJobLookupFailure(params.job_id, jobs));
      }

      const isDelivering = deliveries.has(job.id);
      const activity = job.activity?.slice(-MAX_INSPECTION_ACTIVITY_ENTRIES) ?? [];

      return {
        content: [{
          type: "text" as const,
          text: formatJobInspection(job, isDelivering),
        }],
        details: {
          status: isDelivering ? "delivering" as const : job.status,
          jobId: job.id,
          outputTokens: 0,
          warnings: activity.filter((entry) => entry.type === "warning").map(formatActivityEntry),
          errors: activity.filter((entry) => entry.type === "error").map(formatActivityEntry),
          silent: isSilentMode(),
        },
      };
    },

    renderResult(result, options, theme, context) {
      if (result.details?.silent && !context.isError && result.details.status !== "failed") {
        const warnings = result.details.warnings.map((text) => theme.fg("warning", text));
        const errors = (result.details.errors ?? []).map((text) => theme.fg("error", text));
        return new Text([...warnings, ...errors].join("\n"), 0, 0);
      }

      const output = result.content
        .filter((part) => part.type === "text")
        .map((part) => stripVTControlCharacters(part.text)
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
        .join("\n");
      const lines = output.split("\n");
      const displayLines = options.expanded ? lines : lines.slice(0, 10);
      let text = theme.fg(context.isError ? "error" : "toolOutput", displayLines.join("\n"));
      const remaining = lines.length - displayLines.length;
      if (remaining > 0) {
        text += theme.fg("muted", `\n... (${remaining} more lines, `)
          + theme.fg("dim", keyText("app.tools.expand"))
          + theme.fg("muted", " to expand)");
      }
      return new Text(text, 0, 0);
    },
  });
}

function createSubagentParameters(agentTypes: string[]) {
  return Type.Object({
    agent_type: Type.Optional(StringEnum(agentTypes, {
      description: "Harness; required unless roster_entry or a known resume is used",
    })),
    roster_entry: Type.Optional(Type.String({
      minLength: 1,
      description: "Name from subagent_roster. The roster entry supplies resources and " +
        "roster_file; omit them or pass null. Don't pass {} or manual resource settings " +
        "unless they exactly match the selected entry.",
    })),
    roster_file: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description: "Pi-only child roster file; relative to effective cwd for ad-hoc calls. " +
        "If no child roster file is wanted, omit this field or pass null. " +
        "For non-Pi agents, always omit it or pass null. Do not use placeholder strings.",
    })),
    resources: Type.Optional(Type.Union([Type.Object({
      skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      plugins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      packages: Type.Optional(Type.Array(Type.String(), { maxItems: 0 })),
      mcp_servers: Type.Optional(Type.Union([
        Type.Null(), Type.Array(Type.String(), { maxItems: 0 }),
      ])),
      inherit_personal_resources: Type.Optional(Type.Boolean()),
      inherit_project_resources: Type.Optional(Type.Boolean()),
      include_instruction_files: Type.Optional(Type.Boolean()),
      include_home_system_prompt: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), Type.Null()], {
      description: "Local resource paths and discovery controls; paths are relative to cwd. " +
        "Omit this field or pass null when not supplying a manual resource selection. " +
        "Provision files first. Unsupported selections fail; resources stay fixed on resume.",
    })),
    task_name: Type.String({
      minLength: 1,
      maxLength: 40,
      description:
        "Short human-readable name for this delegated task, " +
        "such as Code review or QA check",
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
    resume_session_id: Type.Optional(Type.Union(
      [
        Type.String({ minLength: 1 }),
        Type.Null(),
      ],
      { description: RESUME_SESSION_GUIDANCE },
    )),
    auto_approve: Type.Optional(Type.Boolean({
      description:
        "Allow the subagent to approve tool use automatically. " +
        "Defaults to false on every call, including resumes. Interactive runs use " +
        "the agent's native permission prompts.",
    })),
    allowed_tools: Type.Optional(Type.Array(
      Type.String({ minLength: 1 }),
      {
        minItems: 1,
        description:
          "Tool names the subagent may use for headless runs, when " +
          "supported. Applies only to this call; omit for no explicit list. " +
          "Interactive runs use native permission controls " +
          "and reject unsupported options.",
      },
    )),
    disallowed_tools: Type.Optional(Type.Array(
      Type.String({ minLength: 1 }),
      {
        minItems: 1,
        description:
          "Tool names the subagent must not use for headless runs, when " +
          "supported. Applies only to this call; omit for no explicit list. " +
          "Interactive runs use native permission controls " +
          "and reject unsupported options.",
      },
    )),
    interactive: Type.Optional(Type.Boolean({
      description:
        "Run the agent's native interactive UI in a neighbouring tmux " +
        "pane. Requires TMUX and TMUX_PANE. Defaults to the configured " +
        "interactive.enabled value.",
    })),
    stay_open: Type.Optional(Type.Boolean({
      description:
        "Keep an interactive pane open after its result is delivered. " +
        "Applies only to interactive runs and defaults to the configured " +
        "interactive.stay_open value.",
    })),
    inactivity_timeout: Type.Optional(Type.Number({
      exclusiveMinimum: 0,
      description:
        "Positive number of seconds used to infer completion after an " +
        "inactive interactive pane when inactivity is enabled. Defaults " +
        "to the configured interactive.inactivity_timeout value.",
    })),
    inactivity_enabled: Type.Optional(Type.Boolean({
      description:
        "Enable automatic closure after inactivity_timeout for interactive " +
        "runs. Defaults to the configured interactive.inactivity_enabled " +
        "value.",
    })),
  });
}

type SubagentInput = Static<ReturnType<typeof createSubagentParameters>>;
type SubagentParams = ReturnType<typeof normalizeLaunchInput>;
type LaunchSelection = Omit<SavedLaunch, "version" | "sessionId">;

function normalizeLaunchInput(input: SubagentInput) {
  // Drop null before restoring saved settings: null means omitted, not cleared.
  const { roster_file, resources, ...provided } = input;
  return { ...provided,
    ...(roster_file == null ? {} : { roster_file }),
    ...(resources == null ? {} : { resources }) };
}

function findSavedLaunch(
  params: SubagentParams,
  launches: LaunchSelectionState,
): SavedLaunch | undefined {
  const { savedLaunches, retainedLaunches } = launches;
  if (params.resume_session_id === "new" || params.resume_session_id?.startsWith("job-")) {
    throw new Error(`Use a returned native Session ID. ${RESUME_SESSION_GUIDANCE}`);
  }
  const candidates = params.resume_session_id ? [...savedLaunches.values()]
    .filter((entry) => entry.sessionId === params.resume_session_id) : [];
  const saved = candidates.length === 1 ? candidates[0]
    : candidates.find((entry) => entry.request.agent_type === params.agent_type);
  if (candidates.length && !saved) {
    throw new Error("Ambiguous native session ID; specify the original agent_type");
  }
  const resumeKey = saved ? launchKey(saved)
    : JSON.stringify([params.agent_type, params.resume_session_id]);
  if (params.resume_session_id && retainedLaunches.has(resumeKey)) {
    throw new Error("This retained interactive session may still be running. "
      + "Shut down or reload its owning Pi session before resuming it here.");
  }
  if (params.resume_session_id && !saved && (params.roster_entry !== undefined
    || params.resources !== undefined || params.roster_file !== undefined)) {
    throw new Error("No recorded launch; cannot verify this session's original selection");
  }
  return saved;
}

function restoreLaunchDefaults(
  params: SubagentParams,
  saved: SavedLaunch | undefined,
): SubagentParams {
  if (!saved) return params;
  if (params.roster_entry !== undefined && params.roster_entry !== saved.role?.name) {
    throw new Error("Resume requires the original roster entry");
  }
  // Restore launch defaults, but approval/tool controls belong only to this call.
  return { ...saved.request, ...params,
    auto_approve: params.auto_approve,
    allowed_tools: params.allowed_tools,
    disallowed_tools: params.disallowed_tools,
    roster_entry: params.roster_entry ?? saved.role?.name };
}

function selectRosterRole(
  params: SubagentParams,
  roster: AgentShellRosterConfig,
  saved: SavedLaunch | undefined,
): AgentShellRosterRole | undefined {
  const role = params.roster_entry === undefined ? undefined
    : roster.roles.find((entry) => entry.name === params.roster_entry);
  if (params.roster_entry !== undefined && !roster.enabled) {
    throw new Error(saved?.role
      ? `Original roster entry "${saved.role.name}" is now disabled; re-enable its roster.`
      : `Roster is disabled; cannot select entry "${params.roster_entry}".`);
  }
  if (params.roster_entry !== undefined && role === undefined) {
    throw new Error(`Unknown roster entry "${params.roster_entry}"`);
  }
  if ((role?.agent_type ?? params.agent_type) !== "pi"
    && (role?.roster_file !== undefined || params.roster_file !== undefined)) {
    throw new Error('roster_file is supported only for agent_type "pi"');
  }
  if (saved?.role && !isDeepStrictEqual(role, saved.role)) {
    const changed = (["name", "description", "agent_type", "model", "effort", "cwd",
      "resources", "roster_file", "agent_file"] as const)
      .filter((key) => !isDeepStrictEqual(role?.[key], saved.role?.[key]));
    throw new Error(`Original roster_entry changed: ${changed.join(", ")}`);
  }
  if (role?.agent_file) {
    const current = loadAgentShellAgentFile(role.agent_file);
    const changed = (Object.keys(current) as Array<keyof AgentShellRosterRole>)
      .filter((key) => !isDeepStrictEqual(current[key], role[key]));
    for (const key of Object.keys(role) as Array<keyof AgentShellRosterRole>) {
      if (!(key in current)) changed.push(key);
    }
    if (changed.length) {
      throw new Error(`Agent definition changed at ${role.agent_file}: ${changed.join(", ")}. `
        + "Run /reload for new launches; start a new session for changed settings.");
    }
  }
  return role;
}

function resolveSelectedSettings(
  params: SubagentParams,
  role: AgentShellRosterRole | undefined,
  parentCwd: string,
) {
  for (const key of ["agent_type", "model", "effort", "cwd"] as const) {
    if (role?.[key] !== undefined && params[key] !== undefined && params[key] !== role[key]) {
      throw new Error(`Manual ${key} conflicts with roster entry "${role.name}"`);
    }
  }
  const cwd = role?.cwd ?? params.cwd ?? parentCwd;
  const manualResources = params.resources === undefined ? undefined
    : resolveSessionResources(params.resources, cwd);
  const manualRosterFile = params.roster_file === undefined ? undefined
    : resolve(cwd, params.roster_file);
  for (const [key, manual, selected] of [
    ["resources", manualResources, role?.resources],
    ["roster_file", manualRosterFile, role?.roster_file],
  ] as const) {
    if (role && manual !== undefined && !isDeepStrictEqual(manual, selected)) {
      throw new Error(`Manual ${key} conflicts with roster entry "${role.name}"`);
    }
  }
  return { ...params, ...role,
    resources: role?.resources ?? manualResources,
    roster_file: role?.roster_file ?? manualRosterFile };
}

function validateResumeSelection(
  saved: SavedLaunch | undefined,
  selection: LaunchSelection,
): void {
  if (saved && (saved.role || saved.request.resources || saved.request.roster_file
    || selection.request.resources || selection.request.roster_file)) {
    // Only the selected role/resources form a resume contract. Model/effort on ad-hoc
    // calls and approval/tool/interactive controls remain explicit per-call choices.
    const changed: string[] = (["agent_type", "cwd", "resources", "roster_file"] as const)
      .filter((key) => !isDeepStrictEqual(selection.request[key], saved.request[key]));
    if (selection.rosterSource !== saved.rosterSource) changed.push("roster source");
    if (!isDeepStrictEqual(selection.childRoster, saved.childRoster)) {
      changed.push("roster_file contents");
    }
    if (changed.length) {
      throw new Error(`Resume conflicts with original selection: ${changed.join(", ")}`);
    }
  }
}

function prepareSubagentLaunch(
  provided: SubagentParams,
  parentCwd: string,
  runtime: SubagentRuntime,
  launches: LaunchSelectionState,
  agentTypes: string[],
): { request: AgentRequest; selection: LaunchSelection; taskName: string } {
  const saved = findSavedLaunch(provided, launches);
  let params = restoreLaunchDefaults(provided, saved);
  const { interactiveConfig, interactiveSupported } = runtime;
  const { getRoster, rosterSource } = launches;
  const interactive = resolveInteractiveLaunchSettings(
    params,
    interactiveConfig,
  );

  if (interactive.interactive && !interactiveSupported) {
    throw new Error([
      "Interactive AgentShell runs need an updated runtime.",
      `Run: ${agentShellSetupCommand()}`,
      "Then restart Pi or run /reload.",
    ].join("\n"));
  }

  if (params.cwd !== undefined) params = { ...params, cwd: resolve(parentCwd, params.cwd) };
  const roster = getRoster();
  const role = selectRosterRole(params, roster, saved);
  const effective = resolveSelectedSettings(params, role, parentCwd);
  const childRoster = effective.roster_file === undefined ? undefined
    : loadAgentShellRosterFile(effective.roster_file);
  if (!effective.agent_type || !agentTypes.includes(effective.agent_type)) {
    throw new Error("Provide a supported agent_type or roster_entry");
  }
  const request: AgentRequest = {
    agent_type: effective.agent_type,
    cwd: effective.cwd ?? parentCwd,
    prompt: params.prompt,
    model: effective.model,
    effort: effective.effort,
    roster_file: effective.roster_file,
    resources: effective.resources,
    session_id: params.resume_session_id ?? undefined,
    auto_approve: params.auto_approve,
    allowed_tools: params.allowed_tools,
    disallowed_tools: params.disallowed_tools,
    ...interactive,
  };

  const { prompt: _prompt, session_id: _sessionId, ...settings } = request;
  const selection = jsonSnapshot({
    request: { ...settings, auto_approve: settings.auto_approve ?? false }, role, childRoster,
    rosterSource: role ? rosterSource : undefined });
  validateResumeSelection(saved, selection);
  // Keep the canonical selection above; only this native dispatch copy uses prompt skills.
  if (role?.agent_file && ["codex", "claude_code"].includes(request.agent_type)
    && request.resources) {
    const files = resolvePromptSkillFiles(request.resources.skills);
    return { request: { ...request, resources: { ...request.resources, skills: [] },
      prompt: request.prompt + (files.length ? "\n\n"
        + "Selected skill files: read and follow these before doing the assigned task.\n"
        + files.map((path) => `- ${JSON.stringify(path)}`).join("\n") : "") },
      selection, taskName: params.task_name };
  }
  return { request, selection, taskName: params.task_name };
}

async function registerSubagentTool(
  pi: ExtensionAPI,
  runtime: SubagentRuntime,
  jobs: JobRegistry,
  delivery: TerminalDeliveryState,
  launches: LaunchSelectionState,
  isSilentMode: () => boolean,
): Promise<(enabled: boolean) => void> {
  const { limits, modelDiscoverySupported, delegation } = runtime;
  const { deliveries, isShuttingDown } = delivery;
  const { getRoster, savedLaunches, retainedLaunches } = launches;
  const agentTypes = await getSupportedAgentTypes(limits);

  registerJobMessageRenderer(pi);
  registerJobDeliveryHandler(pi, jobs, deliveries);
  registerSubagentStatusTool(pi, jobs, deliveries, isSilentMode);

  const registerInvocation = (enabled: boolean): void => pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate a task to an AI coding agent in a separate context.",
      "Long-running subagent calls may return `Subagent job <job-id> started`.",
      "TUI and RPC sessions run jobs in the background. In JSON/print mode, " +
        "the call waits and returns the result directly, without a Job ID or follow-up.",
      "Do not repeatedly poll the process or run sleep commands.",
      "Use subagent_status only when current progress is useful.",
      "A Job ID is not a session ID.",
      "For background jobs, the extension automatically delivers the result " +
        "using a follow-up turn.",
      "While a background job runs, continue other work or remain idle until notified.",
      "If you have no independent work, end your response. The extension will start a new " +
        "turn when the subagent completes.",
      "The real resumable session ID arrives with the completion result.",
      RESUME_SESSION_GUIDANCE,
      ...(enabled ? [
        "Before delegating, check subagent_roster for preferred roles and settings.",
        "Pass roster_entry by name to apply that child's launch settings.",
      ] : []),
    ].join(" "),
    parameters: createSubagentParameters(agentTypes),

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("Subagent ")) +
        theme.fg("accent", args.roster_entry ?? args.agent_type ?? "resume");

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

    async execute(_toolCallId, input, toolSignal, _onUpdate, ctx) {
      const params = normalizeLaunchInput(input);
      const silent = isSilentMode();
      const { request, selection, taskName } = prepareSubagentLaunch(
        params, ctx.cwd, runtime, launches, agentTypes,
      );
      const remember = (result: RunResult): void => {
        if (!result.details.sessionId || isShuttingDown()) return;
        const launch: SavedLaunch = {
          version: 1, sessionId: result.details.sessionId, ...selection,
        };
        savedLaunches.set(launchKey(launch), launch);
        if (request.interactive && request.stay_open) retainedLaunches.add(launchKey(launch));
        pi.appendEntry(LAUNCH_ENTRY_TYPE, launch);
      };

      if (ctx.mode === "json" || ctx.mode === "print") {
        const result = await runAgentShell(request, toolSignal, undefined, limits, delegation);
        remember(result);
        return {
          content: [{ type: "text" as const, text: formatRunOutput(result) }],
          details: result.details,
        };
      }

      const job = jobs.start(
        (signal, jobId) =>
          runAgentShell(
            request,
            signal,
            (update) => {
              jobs.recordActivity(jobId, update.activity);

              if (!isShuttingDown()) {
                safelyUpdateJobWidget(ctx, jobs, deliveries);
              }
            },
            limits,
            delegation,
          ),
        {
          taskName,
          agentType: request.agent_type,
          model: request.model,
          effort: request.effort,
        },
      );

      safelyUpdateJobWidget(ctx, jobs, deliveries);

      void job.completion.then(
        (result) => {
          const status = jobs.get(job.id)?.status === "cancelled"
            ? "cancelled"
            : "completed";
          if (status === "completed") remember(result);
          const output = status === "cancelled"
            ? "The worker stopped after cancellation."
            : formatRunOutput(result);

          sendTerminalMessage(
            pi,
            jobs,
            {
              jobId: job.id,
              status,
              output,
              warnings: result.details.warnings,
              silent,
            },
            delivery,
            () => safelyUpdateJobWidget(ctx, jobs, deliveries),
          );
        },
        (error: unknown) => {
          const status = jobs.get(job.id)?.status === "cancelled"
            ? "cancelled"
            : "failed";
          const message = readErrorMessage(error);
          if (message === undefined) {
            logLocalError(`Subagent job ${job.id} ${status}`, error);
          }

          sendTerminalMessage(
            pi,
            jobs,
            {
              jobId: job.id,
              status,
              output: message ?? UNKNOWN_ERROR_MESSAGE,
              warnings: [],
              silent,
            },
            delivery,
            () => safelyUpdateJobWidget(ctx, jobs, deliveries),
          );
        },
      );

      return formatJobLaunch(job.id);
    },
  });

  registerInvocation(getRoster().enabled);

  if (modelDiscoverySupported) {
    registerSubagentModelsTool(pi, agentTypes, limits);
  }

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
        throw new Error(formatCancellationFailure(params.job_id, jobs));
      }

      safelyUpdateJobWidget(ctx, jobs, deliveries);

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

  return registerInvocation;
}

function registerRosterTool(pi: ExtensionAPI, roster: AgentShellRosterConfig): void {
  pi.registerTool({
    name: "subagent_roster",
    label: "Subagent roster",
    description: "List child roster entries selectable by name through subagent.roster_entry.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{
          type: "text" as const,
          text: roster.roles.length === 0
            ? "No preferred subagent roles are configured."
            : JSON.stringify(roster.roles, null, 2),
        }],
        details: {},
      };
    },
  });
}

export default async function subagentsExtension(
  pi: ExtensionAPI,
): Promise<void> {
  const inheritedDelegation = inheritedAgentShellDelegation();
  if (inheritedDelegation === "blocked") {
    return;
  }

  const agentDirectory = getAgentDir();
  const inheritedMaxDepth = inheritedDelegation === "root"
    ? undefined : inheritedDelegation.maxDepth;
  const config = loadAgentShellConfig(agentDirectory, inheritedMaxDepth);
  const delegation = inheritedDelegation === "root"
    ? Object.freeze({ depth: 0, maxDepth: config.max_sub_agent_depth })
    : inheritedDelegation;
  const limits: AgentShellLimits = config;
  const jobs = new JobRegistry(limits.max_output_bytes);
  const savedLaunches = new Map<string, SavedLaunch>();
  const retainedLaunches = new Set<string>();
  const rosterSource = config.rosterFile ?? join(agentDirectory, "extensions", "agentshell.json");
  const deliveries = new Map<string, TerminalJobStatus>();
  const pendingMessages: PendingTerminalMessage[] = [];
  let parentAgentActive = false;
  let shuttingDown = false;
  let silentMode = config.silent;
  let refreshSubagentTool: ((enabled: boolean) => void) | undefined;

  if (config.roster.enabled) {
    registerRosterTool(pi, config.roster);
  }

  pi.on("agent_start", () => {
    parentAgentActive = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle()) {
      parentAgentActive = true;
      return;
    }

    parentAgentActive = false;

    flushPendingTerminalMessages(
      pi,
      jobs,
      pendingMessages,
      () => shuttingDown,
      deliveries,
      () => safelyUpdateJobWidget(ctx, jobs, deliveries),
    );
  });

  const restoreLaunches = (ctx: ExtensionContext): void => {
    // Tree navigation must retain contracts already known to this running extension.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === LAUNCH_ENTRY_TYPE) {
        const launch = entry.data as SavedLaunch | undefined;
        if (launch?.version === 1 && typeof launch.sessionId === "string"
          && typeof launch.request?.agent_type === "string") {
          savedLaunches.set(launchKey(launch), launch);
        }
      }
    }
  };
  pi.on("session_tree", (_event, ctx) => restoreLaunches(ctx));

  pi.on("session_start", (_event, ctx) => {
    parentAgentActive = false;
    pendingMessages.length = 0;
    deliveries.clear();
    shuttingDown = false;
    silentMode = config.silent;
    savedLaunches.clear();
    restoreLaunches(ctx);

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

  pi.on("session_shutdown", async (_event, ctx) => {
    parentAgentActive = false;
    pendingMessages.length = 0;
    shuttingDown = true;
    jobs.cancelAll();
    await closeAgentShellWorkers();
    retainedLaunches.clear();
    jobs.clear();
    deliveries.clear();
    safelyUpdateJobWidget(ctx, jobs, deliveries);
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

  pi.registerCommand("agentshell-roster", {
    description: "Toggle the selected roster (session-only for an explicit roster file)",
    handler: async (_args, ctx) => {
      try {
        const currentRoster = config.rosterFile ? config.roster
          : loadAgentShellConfig(agentDirectory, inheritedMaxDepth).roster;
        const enabled = !currentRoster.enabled;
        if (!config.rosterFile) setRosterEnabled(agentDirectory, enabled, inheritedMaxDepth);
        config.roster = { ...currentRoster, enabled };

        if (enabled) {
          registerRosterTool(pi, config.roster);
        }

        refreshSubagentTool?.(enabled);
        const activeTools = pi.getActiveTools();
        pi.setActiveTools(enabled
          ? [...new Set([...activeTools, "subagent_roster"])]
          : activeTools.filter((name) => name !== "subagent_roster"));
        ctx.ui.notify(
          enabled ? "Subagent roster is now enabled."
            : "Subagent roster is now disabled.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Could not toggle subagent roster: ${localErrorDiagnostic(error)}`, "error");
      }
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
        activeJobs
          .map((job) => formatJobListEntry(job, deliveries.has(job.id)))
          .join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("agentshell-inspect", {
    description: "Inspect recent activity for an active subagent job",
    handler: async (args, ctx) => {
      const jobId = args.trim();

      if (jobId.length === 0) {
        ctx.ui.notify("Usage: /agentshell-inspect <job-id>", "warning");
        return;
      }

      const job = jobs.get(jobId);
      ctx.ui.notify(
        job === undefined
          ? formatJobLookupFailure(jobId, jobs)
          : formatJobInspection(job, deliveries.has(jobId)),
        job === undefined ? "warning" : "info",
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
        safelyUpdateJobWidget(ctx, jobs, deliveries);
      }

      ctx.ui.notify(
        cancelled
          ? `Subagent job ${jobId} cancelled.`
          : formatCancellationFailure(jobId, jobs),
        cancelled ? "info" : "warning",
      );
    },
  });

  const delivery: TerminalDeliveryState = {
    deliveries,
    pendingMessages,
    isParentAgentActive: () => parentAgentActive,
    isShuttingDown: () => shuttingDown,
  };
  const launches: LaunchSelectionState = {
    getRoster: () => config.roster,
    rosterSource,
    savedLaunches,
    retainedLaunches,
  };
  const registerTool = async (): Promise<void> => {
    refreshSubagentTool = await registerSubagentTool(
      pi,
      {
        limits,
        interactiveConfig: config.interactive,
        modelDiscoverySupported: supportsAgentShellModelDiscovery(),
        interactiveSupported: supportsAgentShellInteractive(),
        delegation,
      },
      jobs,
      delivery,
      launches,
      () => silentMode,
    );
  };

  if (isAgentShellRuntimeInstalled()) {
    const modelDiscoverySupported = supportsAgentShellModelDiscovery();
    const interactiveSupported = supportsAgentShellInteractive();
    refreshSubagentTool = await registerSubagentTool(
      pi,
      {
        limits,
        interactiveConfig: config.interactive,
        modelDiscoverySupported,
        interactiveSupported,
        delegation,
      },
      jobs,
      delivery,
      launches,
      () => silentMode,
    );

    if (
      !modelDiscoverySupported ||
      (config.interactive.enabled && !interactiveSupported)
    ) {
      pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI) {
          return;
        }

        const notices = [];

        if (!modelDiscoverySupported) {
          notices.push([
            "Model discovery needs an updated AgentShell runtime.",
            `Run: ${agentShellSetupCommand()}`,
            "Then restart Pi or run /reload.",
          ].join("\n"));
        }

        if (config.interactive.enabled && !interactiveSupported) {
          notices.push([
            "Interactive runs need an updated AgentShell runtime.",
            `Run: ${agentShellSetupCommand()}`,
            "Then restart Pi or run /reload.",
          ].join("\n"));
        }

        ctx.ui.notify(
          notices.join("\n\n"),
          "warning",
        );
      });
    }

    return;
  }

  let setupAttempted = false;

  pi.on("session_start", async (_event, ctx) => {
    if (setupAttempted) {
      return;
    }

    setupAttempted = true;
    const command = agentShellSetupCommand();

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
        "--no-build",
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
