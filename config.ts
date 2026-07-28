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

function invalidConfiguration(path: string, reason: string): Error {
  return new Error(
    `Invalid AgentShell configuration at ${path}: ${reason}`,
  );
}

export function loadAgentShellLimits(
  agentDirectory: string,
): AgentShellLimits {
  const configPath = join(
    agentDirectory,
    "extensions",
    "agentshell.json",
  );

  if (!existsSync(configPath)) {
    return { ...DEFAULT_AGENT_SHELL_LIMITS };
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

  for (const [setting, value] of Object.entries(overrides)) {
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

  return limits;
}
