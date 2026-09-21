import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG,
  DEFAULT_AGENT_SHELL_ROSTER_CONFIG,
  loadAgentShellConfig,
  loadAgentShellLimits,
  setRosterEnabled,
} from "../config.ts";
import { DEFAULT_AGENT_SHELL_LIMITS } from "../limits.ts";

function writeConfig(
  agentDirectory: string,
  config: unknown,
): string {
  const extensionDirectory = join(agentDirectory, "extensions");
  const configPath = join(extensionDirectory, "agentshell.json");

  mkdirSync(extensionDirectory);
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

test("uses default limits when no config file exists", () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-limits-"),
  );

  try {
    assert.deepEqual(
      loadAgentShellLimits(agentDirectory),
      DEFAULT_AGENT_SHELL_LIMITS,
    );
    assert.deepEqual(loadAgentShellConfig(agentDirectory), {
      ...DEFAULT_AGENT_SHELL_LIMITS,
      interactive: DEFAULT_AGENT_SHELL_INTERACTIVE_CONFIG,
      roster: DEFAULT_AGENT_SHELL_ROSTER_CONFIG,
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("loads partial limit overrides from the AgentShell config file", () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-limits-"),
  );

  try {
    writeConfig(agentDirectory, { maxOutputBytes: 128 * 1024 });

    assert.deepEqual(loadAgentShellLimits(agentDirectory), {
      ...DEFAULT_AGENT_SHELL_LIMITS,
      maxOutputBytes: 128 * 1024,
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("loads interactive defaults and nested overrides with existing limits", () => {
  // Arrange
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-interactive-config-"),
  );

  try {
    writeConfig(agentDirectory, {
      maxOutputBytes: 128 * 1024,
      interactive: {
        enabled: true,
        stay_open: true,
        inactivity_timeout: 15,
        inactivity_enabled: false,
      },
    });

    // Act
    const config = loadAgentShellConfig(agentDirectory);

    // Assert
    assert.deepEqual(config, {
      ...DEFAULT_AGENT_SHELL_LIMITS,
      maxOutputBytes: 128 * 1024,
      interactive: {
        enabled: true,
        stay_open: true,
        inactivity_timeout: 15,
        inactivity_enabled: false,
      },
      roster: DEFAULT_AGENT_SHELL_ROSTER_CONFIG,
    });
    assert.deepEqual(loadAgentShellLimits(agentDirectory), {
      ...DEFAULT_AGENT_SHELL_LIMITS,
      maxOutputBytes: 128 * 1024,
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("persists the global roster switch without changing other settings", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-"));

  try {
    const configPath = writeConfig(agentDirectory, {
      maxOutputBytes: 128 * 1024,
      roster: {
        roles: [{
          name: "reviewer",
          description: "Review code for defects",
          agent_type: "codex",
          model: "gpt-5",
          effort: "high",
        }],
      },
    });

    setRosterEnabled(agentDirectory, true);

    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      maxOutputBytes: 128 * 1024,
      roster: {
        roles: [{
          name: "reviewer",
          description: "Review code for defects",
          agent_type: "codex",
          model: "gpt-5",
          effort: "high",
        }],
        enabled: true,
      },
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("toggles a symlinked config without replacing the link", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-link-"));

  try {
    const extensionDirectory = join(agentDirectory, "extensions");
    const dotfilesDirectory = join(agentDirectory, "dotfiles");
    const configPath = join(extensionDirectory, "agentshell.json");
    const targetPath = join(dotfilesDirectory, "agentshell.json");
    mkdirSync(extensionDirectory);
    mkdirSync(dotfilesDirectory);
    writeFileSync(targetPath, JSON.stringify({ roster: { enabled: false } }));
    symlinkSync(targetPath, configPath);

    setRosterEnabled(agentDirectory, true);

    assert.equal(lstatSync(configPath).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), {
      roster: { enabled: true },
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("does not replace a broken config symlink", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-link-"));

  try {
    const extensionDirectory = join(agentDirectory, "extensions");
    const configPath = join(extensionDirectory, "agentshell.json");
    mkdirSync(extensionDirectory);
    symlinkSync(join(agentDirectory, "missing.json"), configPath);

    assert.throws(() => setRosterEnabled(agentDirectory, true), { code: "ENOENT" });
    assert.equal(lstatSync(configPath).isSymbolicLink(), true);
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("enables the roster when the global config file does not exist yet", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-"));

  try {
    setRosterEnabled(agentDirectory, true);

    assert.deepEqual(loadAgentShellConfig(agentDirectory).roster, {
      enabled: true,
      roles: [],
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("loads an advisory roster from the global AgentShell config", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-"));

  try {
    writeConfig(agentDirectory, {
      roster: {
        enabled: true,
        roles: [{
          name: "reviewer",
          description: "Review code for defects",
          agent_type: "codex",
          model: "gpt-5",
          effort: "high",
        }],
      },
    });

    assert.deepEqual(loadAgentShellConfig(agentDirectory).roster, {
      enabled: true,
      roles: [{
        name: "reviewer",
        description: "Review code for defects",
        agent_type: "codex",
        model: "gpt-5",
        effort: "high",
      }],
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("rejects incomplete and duplicate roster roles", () => {
  const cases = [
    {
      roles: [{ name: "reviewer", description: "Review code", agent_type: "codex",
        model: "gpt-5" }],
      error: "roster.roles[0].effort must be a non-empty string",
    },
    {
      roles: [
        { name: "reviewer", description: "Review code", agent_type: "codex",
          model: "gpt-5", effort: "high" },
        { name: "reviewer", description: "Review tests", agent_type: "codex",
          model: "gpt-5", effort: "medium" },
      ],
      error: 'duplicate roster role name "reviewer"',
    },
  ];

  for (const { roles, error } of cases) {
    const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-"));

    try {
      const configPath = writeConfig(agentDirectory, { roster: { roles } });
      assert.throws(() => loadAgentShellConfig(agentDirectory), {
        message: `Invalid AgentShell configuration at ${configPath}: ${error}`,
      });
    } finally {
      rmSync(agentDirectory, { recursive: true, force: true });
    }
  }
});

test("rejects unknown AgentShell limit settings", () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-limits-"),
  );

  try {
    const configPath = writeConfig(agentDirectory, { unexpected: 1 });

    assert.throws(
      () => loadAgentShellLimits(agentDirectory),
      {
        message:
          `Invalid AgentShell configuration at ${configPath}: ` +
          'unknown setting "unexpected"',
      },
    );
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("requires positive safe-integer limit values", () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-limits-"),
  );

  try {
    const configPath = writeConfig(agentDirectory, {
      maxOutputBytes: 0,
    });

    assert.throws(
      () => loadAgentShellLimits(agentDirectory),
      {
        message:
          `Invalid AgentShell configuration at ${configPath}: ` +
          "maxOutputBytes must be a positive safe integer",
      },
    );
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("requires content limits not to exceed the protocol limit", () => {
  const cases = [
    {
      overrides: {
        maxOutputBytes: 201,
        maxProtocolBytes: 200,
        maxMessageBytes: 100,
      },
      setting: "maxOutputBytes",
    },
    {
      overrides: {
        maxOutputBytes: 100,
        maxProtocolBytes: 200,
        maxMessageBytes: 201,
      },
      setting: "maxMessageBytes",
    },
  ];

  for (const { overrides, setting } of cases) {
    const agentDirectory = mkdtempSync(
      join(tmpdir(), "pi-agentshell-limits-"),
    );

    try {
      const configPath = writeConfig(agentDirectory, overrides);

      assert.throws(
        () => loadAgentShellLimits(agentDirectory),
        {
          message:
            `Invalid AgentShell configuration at ${configPath}: ` +
            `${setting} cannot exceed maxProtocolBytes`,
        },
      );
    } finally {
      rmSync(agentDirectory, { recursive: true, force: true });
    }
  }
});

test("rejects a non-object AgentShell limit configuration", () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-limits-"),
  );

  try {
    const configPath = writeConfig(agentDirectory, []);

    assert.throws(
      () => loadAgentShellLimits(agentDirectory),
      {
        message:
          `Invalid AgentShell configuration at ${configPath}: ` +
          "file must contain a JSON object",
      },
    );
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("reports malformed AgentShell limit configuration", () => {
  const agentDirectory = mkdtempSync(
    join(tmpdir(), "pi-agentshell-limits-"),
  );
  const extensionDirectory = join(agentDirectory, "extensions");
  const configPath = join(extensionDirectory, "agentshell.json");

  try {
    mkdirSync(extensionDirectory);
    writeFileSync(configPath, "{", "utf8");

    assert.throws(
      () => loadAgentShellLimits(agentDirectory),
      {
        message:
          `Invalid AgentShell configuration at ${configPath}: ` +
          "file must contain valid JSON",
      },
    );
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});
