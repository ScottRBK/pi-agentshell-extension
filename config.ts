import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

export interface AgentShellConfig extends AgentShellLimits {
  interactive: AgentShellInteractiveConfig;
}

export const DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG:
  AgentShellInteractiveConfig = {
    enabled: false,
    stay_open: false,
    inactivity_timeout: 60,
    inactivity_enabled: true,
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

  for (const [setting, value] of Object.entries(overrides)) {
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

  return { ...limits, interactive };
}
