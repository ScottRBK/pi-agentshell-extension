import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_AGENT_SHELL_LIMITS,
  type AgentShellLimits,
} from "./limits.ts";

const LIMIT_SETTINGS = new Set<keyof AgentShellLimits>([
  "maxOutputBytes",
  "maxProtocolBytes",
  "maxMessageBytes",
  "maxStderrBytes",
]);

export interface AgentShellInteractiveConfig {
  enabled: boolean;
  stay_open: boolean;
  inactivity_timeout: number;
  inactivity_enabled: boolean;
}

export interface AgentShellRosterRole {
  name: string;
  description: string;
  agent_type: string;
  model: string;
  effort: string;
}

export interface AgentShellRosterConfig {
  enabled: boolean;
  roles: AgentShellRosterRole[];
}

export interface AgentShellConfig extends AgentShellLimits {
  interactive: AgentShellInteractiveConfig;
  roster: AgentShellRosterConfig;
}

export const DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG:
  AgentShellInteractiveConfig = {
    enabled: false,
    stay_open: false,
    inactivity_timeout: 60,
    inactivity_enabled: true,
  };

export const DEFAULT_AGENT_SHELL_ROSTER_CONFIG: AgentShellRosterConfig = {
  enabled: false,
  roles: [],
};

function invalidConfiguration(path: string, reason: string): Error {
  return new Error(
    `Invalid AgentShell configuration at ${path}: ${reason}`,
  );
}

export function loadAgentShellLimits(
  agentDirectory: string,
): AgentShellLimits {
  const config = loadAgentShellConfig(agentDirectory);

  return {
    maxOutputBytes: config.maxOutputBytes,
    maxProtocolBytes: config.maxProtocolBytes,
    maxMessageBytes: config.maxMessageBytes,
    maxStderrBytes: config.maxStderrBytes,
  };
}

export function loadAgentShellConfig(
  agentDirectory: string,
): AgentShellConfig {
  const configPath = join(
    agentDirectory,
    "extensions",
    "agentshell.json",
  );

  if (!existsSync(configPath)) {
    return {
      ...DEFAULT_AGENT_SHELL_LIMITS,
      interactive: { ...DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG },
      roster: { ...DEFAULT_AGENT_SHELL_ROSTER_CONFIG, roles: [] },
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw invalidConfiguration(
        configPath,
        "file must contain valid JSON",
      );
    }

    throw error;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw invalidConfiguration(
      configPath,
      "file must contain a JSON object",
    );
  }

  const overrides = parsed as Record<string, unknown>;
  const limits = { ...DEFAULT_AGENT_SHELL_LIMITS };
  const interactive = { ...DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG };
  const roster: AgentShellRosterConfig = {
    ...DEFAULT_AGENT_SHELL_ROSTER_CONFIG,
    roles: [],
  };

  for (const [setting, value] of Object.entries(overrides)) {
    if (setting === "roster") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidConfiguration(configPath, "roster must be a JSON object");
      }

      for (const [rosterSetting, rosterValue] of Object.entries(value)) {
        if (rosterSetting === "enabled") {
          if (typeof rosterValue !== "boolean") {
            throw invalidConfiguration(configPath, "roster.enabled must be a boolean");
          }
          roster.enabled = rosterValue;
        } else if (rosterSetting === "roles") {
          if (!Array.isArray(rosterValue)) {
            throw invalidConfiguration(configPath, "roster.roles must be an array");
          }
          const names = new Set<string>();
          roster.roles = rosterValue.map((role, index) => {
            if (typeof role !== "object" || role === null || Array.isArray(role)) {
              throw invalidConfiguration(
                configPath,
                `roster.roles[${index}] must be a JSON object`,
              );
            }
            const fields = ["name", "description", "agent_type", "model", "effort"] as const;
            for (const key of Object.keys(role)) {
              if (!fields.includes(key as typeof fields[number])) {
                throw invalidConfiguration(
                  configPath,
                  `unknown roster.roles[${index}] setting "${key}"`,
                );
              }
            }
            for (const field of fields) {
              if (typeof role[field] !== "string" || role[field].trim().length === 0) {
                throw invalidConfiguration(
                  configPath,
                  `roster.roles[${index}].${field} must be a non-empty string`,
                );
              }
            }
            const parsedRole = role as AgentShellRosterRole;
            if (names.has(parsedRole.name)) {
              throw invalidConfiguration(
                configPath,
                `duplicate roster role name "${parsedRole.name}"`,
              );
            }
            names.add(parsedRole.name);
            return parsedRole;
          });
        } else {
          throw invalidConfiguration(
            configPath,
            `unknown roster setting "${rosterSetting}"`,
          );
        }
      }
      continue;
    }

    if (setting === "interactive") {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
      ) {
        throw invalidConfiguration(
          configPath,
          "interactive must be a JSON object",
        );
      }

      for (const [interactiveSetting, interactiveValue] of Object.entries(
        value,
      )) {
        if (
          !(
            interactiveSetting === "enabled" ||
            interactiveSetting === "stay_open" ||
            interactiveSetting === "inactivity_timeout" ||
            interactiveSetting === "inactivity_enabled"
          )
        ) {
          throw invalidConfiguration(
            configPath,
            `unknown interactive setting "${interactiveSetting}"`,
          );
        }

        if (
          interactiveSetting === "inactivity_timeout"
        ) {
          if (
            typeof interactiveValue !== "number" ||
            !Number.isFinite(interactiveValue) ||
            interactiveValue <= 0
          ) {
            throw invalidConfiguration(
              configPath,
              `${interactiveSetting} must be a positive finite number`,
            );
          }

          interactive.inactivity_timeout = interactiveValue;
          continue;
        }

        if (typeof interactiveValue !== "boolean") {
          throw invalidConfiguration(
            configPath,
            `${interactiveSetting} must be a boolean`,
          );
        }

        interactive[interactiveSetting] = interactiveValue;
      }

      continue;
    }

    if (!LIMIT_SETTINGS.has(setting as keyof AgentShellLimits)) {
      throw invalidConfiguration(
        configPath,
        `unknown setting "${setting}"`,
      );
    }

    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      throw invalidConfiguration(
        configPath,
        `${setting} must be a positive safe integer`,
      );
    }

    limits[setting as keyof AgentShellLimits] = value;
  }

  for (const setting of [
    "maxOutputBytes",
    "maxMessageBytes",
  ] as const) {
    if (limits[setting] > limits.maxProtocolBytes) {
      throw invalidConfiguration(
        configPath,
        `${setting} cannot exceed maxProtocolBytes`,
      );
    }
  }

  return { ...limits, interactive, roster };
}

export function setRosterEnabled(agentDirectory: string, enabled: boolean): void {
  loadAgentShellConfig(agentDirectory);
  const extensionDirectory = join(agentDirectory, "extensions");
  const configPath = join(extensionDirectory, "agentshell.json");
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    : {};
  const roster = existing.roster as Record<string, unknown> | undefined;
  const updated = {
    ...existing,
    roster: { ...roster, enabled },
  };
  const targetPath = lstatSync(configPath, { throwIfNoEntry: false })?.isSymbolicLink()
    ? realpathSync(configPath)
    : configPath;
  const temporaryPath = join(
    dirname(targetPath),
    `.agentshell-${process.pid}-${Date.now()}.tmp`,
  );

  mkdirSync(extensionDirectory, { recursive: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
