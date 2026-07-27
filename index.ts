import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  AGENT_SHELL_PROJECT_DIRECTORY,
  getSupportedAgentTypes,
  isAgentShellRuntimeInstalled,
  runAgentShell,
} from "./runner.ts";

const UV_INSTALL_URL =
  "https://docs.astral.sh/uv/getting-started/installation/";

function setupCommand(): string {
  return [
    "uv sync --project",
    `"${AGENT_SHELL_PROJECT_DIRECTORY}"`,
    "--locked",
  ].join(" ");
}

function formatRunOutput(output: string, warnings: string[]): string {
  const warningOutput = warnings
    .map((warning) => `Warning: ${warning}`)
    .join("\n");

  return [warningOutput, output]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

async function registerSubagentTool(
  pi: ExtensionAPI,
): Promise<void> {
  const agentTypes = await getSupportedAgentTypes();

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to an AI coding agent in a separate context",
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runAgentShell(
        {
          agent_type: params.agent_type,
          cwd: params.cwd ?? ctx.cwd,
          prompt: params.prompt,
          model: params.model,
          effort: params.effort,
          auto_approve: params.auto_approve,
          allowed_tools: params.allowed_tools,
          disallowed_tools: params.disallowed_tools,
        },
        signal,
        (update) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: formatRunOutput(
                  update.output,
                  update.details.warnings,
                ),
              },
            ],
            details: update.details,
          });
        },
      );

      return {
        content: [
          {
            type: "text",
            text: formatRunOutput(
              result.output,
              result.details.warnings,
            ),
          },
        ],
        details: result.details,
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

  if (isAgentShellRuntimeInstalled()) {
    await registerSubagentTool(pi);
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
      await registerSubagentTool(pi);
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
