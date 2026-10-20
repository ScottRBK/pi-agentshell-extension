import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_AGENT_SHELL_LIMITS,
  type AgentShellLimits,
} from "./limits.ts";

const LIMIT_SETTINGS = new Set<keyof AgentShellLimits>([
  "max_output_bytes",
  "max_protocol_bytes",
  "max_message_bytes",
  "max_stderr_bytes",
]);

export interface AgentShellInteractiveConfig {
  enabled: boolean;
  stay_open: boolean;
  inactivity_timeout: number;
  inactivity_enabled: boolean;
}

export interface AgentShellResources {
  skills: string[];
  plugins: string[];
  extensions: string[];
  packages: never[];
  mcp_servers: never[] | null;
  inherit_personal_resources: boolean;
  inherit_project_resources: boolean;
  include_instruction_files: boolean;
  include_home_system_prompt: boolean;
}

export interface AgentShellRosterRole {
  name: string;
  description: string;
  agent_type: string;
  model: string;
  effort: string;
  cwd?: string;
  roster_file?: string;
  resources?: AgentShellResources;
}

export interface AgentShellRosterConfig {
  enabled: boolean;
  roles: AgentShellRosterRole[];
}

export interface AgentShellConfig extends AgentShellLimits {
  max_sub_agent_depth: number;
  silent: boolean;
  interactive: AgentShellInteractiveConfig;
  roster: AgentShellRosterConfig;
  rosterFile?: string;
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
    max_output_bytes: config.max_output_bytes,
    max_protocol_bytes: config.max_protocol_bytes,
    max_message_bytes: config.max_message_bytes,
    max_stderr_bytes: config.max_stderr_bytes,
  };
}

function readConfiguration(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfiguration(path, error instanceof SyntaxError
      ? "file must contain valid JSON" : String(error));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidConfiguration(path, "file must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function localPath(value: unknown, base: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty local path without NUL`);
  }
  if (/^(?:[a-z]+:|~)/i.test(value)) {
    throw new Error(`${field} must be a provisioned local path, not a URL, package or ~ path`);
  }
  const path = resolve(base, value);
  const stat = statSync(path, { throwIfNoEntry: false });
  let valid = stat?.isFile() || stat?.isDirectory();
  if (field === "cwd") {
    valid = stat?.isDirectory();
  } else if (field === "roster_file") {
    valid = stat?.isFile();
  }
  if (!valid) {
    throw new Error(`Invalid ${field} path: ${path}`);
  }
  return path;
}

function localResourcePaths(value: unknown, base: string, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((path) => localPath(path, base, field));
}

/** The extension accepts provisioned local resources only; it never installs packages. */
export function resolveSessionResources(value: unknown, base: string): AgentShellResources {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("resources must be a JSON object");
  }
  const result: AgentShellResources = {
    skills: [], plugins: [], extensions: [], packages: [], mcp_servers: null,
    inherit_personal_resources: true, inherit_project_resources: true,
    include_instruction_files: true, include_home_system_prompt: true,
  };
  for (const [key, setting] of Object.entries(value)) {
    switch (key) {
      case "skills":
      case "plugins":
      case "extensions":
        result[key] = localResourcePaths(setting, base, `resources.${key}`);
        break;
      case "packages":
      case "mcp_servers":
        if (key === "mcp_servers" && setting === null) break;
        if (!Array.isArray(setting) || setting.length !== 0) {
          throw new Error(`resources.${key} supports only []; provision local files separately`);
        }
        result[key] = [];
        break;
      case "inherit_personal_resources":
      case "inherit_project_resources":
      case "include_instruction_files":
      case "include_home_system_prompt":
        if (typeof setting !== "boolean") throw new Error(`resources.${key} must be a boolean`);
        result[key] = setting;
        break;
      default:
        throw new Error(`Unknown resources setting "${key}"`);
    }
  }
  return result;
}

function validateRosterRoleFields(
  role: Record<string, unknown>,
  index: number,
  configPath: string,
): void {
  const fields = ["name", "description", "agent_type", "model", "effort"] as const;
  for (const key of Object.keys(role)) {
    if (![...fields, "cwd", "roster_file", "resources"].includes(key)) {
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
  if ("roster_file" in role && role.agent_type !== "pi") {
    throw invalidConfiguration(configPath,
      `roster.roles[${index}].roster_file is supported only for agent_type "pi"`);
  }
}

function parseRoster(value: unknown, configPath: string): AgentShellRosterConfig {
  const roster: AgentShellRosterConfig = { enabled: false, roles: [] };
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
        validateRosterRoleFields(role, index, configPath);
        const parsedRole = { ...role } as AgentShellRosterRole;
        try {
          for (const field of ["cwd", "roster_file"] as const) {
            if (field in role) {
              parsedRole[field] = localPath(role[field], dirname(configPath), field);
            }
          }
          if ("resources" in role) {
            parsedRole.resources = resolveSessionResources(role.resources, dirname(configPath));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw invalidConfiguration(configPath,
            `roster.roles[${index}] ("${parsedRole.name}"): ${message}`);
        }
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
  return roster;
}

/** Read a roster-only file, without consulting personal preferences or following child rosters. */
export function loadAgentShellRosterFile(path: string): AgentShellRosterConfig {
  const selected = readConfiguration(path);
  if (Object.keys(selected).length !== 1 || !("roster" in selected)) {
    throw invalidConfiguration(path, "selected file must contain only the roster key");
  }
  return parseRoster(selected.roster, path);
}

export function loadAgentShellConfig(
  agentDirectory: string,
  inheritedMaxDepth?: number,
): AgentShellConfig {
  const configPath = join(
    agentDirectory,
    "extensions",
    "agentshell.json",
  );

  const rosterFile = process.env.PI_AGENTSHELL_ROSTER_FILE;
  if (rosterFile !== undefined && (!rosterFile.trim() || rosterFile.includes("\0"))) {
    throw new Error("PI_AGENTSHELL_ROSTER_FILE must be a non-empty path without NUL");
  }
  const selectedPath = rosterFile === undefined ? undefined : resolve(rosterFile);
  const overrides = existsSync(configPath) ? readConfiguration(configPath) : {};
  const limits = { ...DEFAULT_AGENT_SHELL_LIMITS };
  let maxSubAgentDepth = inheritedMaxDepth ?? 0;
  let silent = false;
  const interactive = { ...DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG };
  let roster: AgentShellRosterConfig = selectedPath === undefined
    ? { ...DEFAULT_AGENT_SHELL_ROSTER_CONFIG, roles: [] }
    : loadAgentShellRosterFile(selectedPath);

  for (const [setting, value] of Object.entries(overrides)) {
    if (setting === "max_sub_agent_depth") {
      // Descendants use their root's policy, not a later or different local setting.
      if (inheritedMaxDepth !== undefined) continue;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw invalidConfiguration(
          configPath,
          "max_sub_agent_depth must be a nonnegative safe integer",
        );
      }
      maxSubAgentDepth = value;
      continue;
    }

    if (setting === "silent") {
      if (typeof value !== "boolean") {
        throw invalidConfiguration(configPath, "silent must be a boolean");
      }
      silent = value;
      continue;
    }

    if (setting === "roster") {
      if (selectedPath === undefined) roster = parseRoster(value, configPath);
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
    "max_output_bytes",
    "max_message_bytes",
  ] as const) {
    if (limits[setting] > limits.max_protocol_bytes) {
      throw invalidConfiguration(
        configPath,
        `${setting} cannot exceed max_protocol_bytes`,
      );
    }
  }

  return { ...limits, max_sub_agent_depth: maxSubAgentDepth, silent, interactive, roster,
    ...(selectedPath === undefined ? {} : { rosterFile: selectedPath }) };
}

export function setRosterEnabled(
  agentDirectory: string,
  enabled: boolean,
  inheritedMaxDepth?: number,
): void {
  loadAgentShellConfig(agentDirectory, inheritedMaxDepth);
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
