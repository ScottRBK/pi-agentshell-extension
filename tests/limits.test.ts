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
      max_sub_agent_depth: 0,
      silent: false,
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
    writeConfig(agentDirectory, { max_output_bytes: 128 * 1024 });

    assert.deepEqual(loadAgentShellLimits(agentDirectory), {
      ...DEFAULT_AGENT_SHELL_LIMITS,
      max_output_bytes: 128 * 1024,
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
      max_output_bytes: 128 * 1024,
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
      max_sub_agent_depth: 0,
      max_output_bytes: 128 * 1024,
      silent: false,
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
      max_output_bytes: 128 * 1024,
    });
  } finally {
    rmSync(agentDirectory, { recursive: true, force: true });
  }
});

test("loads only nonnegative safe integer max_sub_agent_depth values", () => {
  for (const depth of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-depth-"));
    try {
      writeConfig(directory, { max_sub_agent_depth: depth });

      // Act / Assert
      assert.equal(loadAgentShellConfig(directory).max_sub_agent_depth, depth);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("rejects invalid explicit max_sub_agent_depth values with the config path", () => {
  for (const depth of [-1, 0.5, "1", null, true, false, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-depth-"));
    try {
      const path = writeConfig(directory, { max_sub_agent_depth: depth });

      // Act / Assert
      assert.throws(() => loadAgentShellConfig(directory), {
        message: `Invalid AgentShell configuration at ${path}: ` +
          "max_sub_agent_depth must be a nonnegative safe integer",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("loads either global silent default alongside existing settings", () => {
  for (const silent of [false, true]) {
    // Arrange
    const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-silent-config-"));
    try {
      writeConfig(agentDirectory, { silent, max_output_bytes: 128 * 1024 });

      // Act
      const config = loadAgentShellConfig(agentDirectory);

      // Assert
      assert.equal(config.silent, silent);
      assert.equal(config.max_output_bytes, 128 * 1024);
    } finally {
      rmSync(agentDirectory, { recursive: true, force: true });
    }
  }
});

test("rejects non-boolean global silent settings", () => {
  for (const silent of ["true", 1, null, {}, []]) {
    // Arrange
    const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-silent-config-"));
    try {
      writeConfig(agentDirectory, { silent });

      // Act / Assert
      assert.throws(() => loadAgentShellConfig(agentDirectory), /silent must be a boolean/);
    } finally {
      rmSync(agentDirectory, { recursive: true, force: true });
    }
  }
});

test("persists the global roster switch without changing other settings", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-roster-"));

  try {
    // Arrange
    const configPath = writeConfig(agentDirectory, {
      max_sub_agent_depth: 2,
      max_output_bytes: 128 * 1024,
      max_protocol_bytes: 4 * 1024 * 1024,
      max_message_bytes: 512 * 1024,
      max_stderr_bytes: 512 * 1024,
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

    // Act
    setRosterEnabled(agentDirectory, true);

    // Assert
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      max_sub_agent_depth: 2,
      max_output_bytes: 128 * 1024,
      max_protocol_bytes: 4 * 1024 * 1024,
      max_message_bytes: 512 * 1024,
      max_stderr_bytes: 512 * 1024,
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
    assert.equal(loadAgentShellConfig(agentDirectory).max_sub_agent_depth, 2);
    assert.deepEqual(loadAgentShellLimits(agentDirectory), {
      max_output_bytes: 128 * 1024,
      max_protocol_bytes: 4 * 1024 * 1024,
      max_message_bytes: 512 * 1024,
      max_stderr_bytes: 512 * 1024,
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
      max_output_bytes: 0,
    });

    assert.throws(
      () => loadAgentShellLimits(agentDirectory),
      {
        message:
          `Invalid AgentShell configuration at ${configPath}: ` +
          "max_output_bytes must be a positive safe integer",
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
        max_output_bytes: 201,
        max_protocol_bytes: 200,
        max_message_bytes: 100,
      },
      setting: "max_output_bytes",
    },
    {
      overrides: {
        max_output_bytes: 100,
        max_protocol_bytes: 200,
        max_message_bytes: 201,
      },
      setting: "max_message_bytes",
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
            `${setting} cannot exceed max_protocol_bytes`,
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

for (const setting of ["MAX_SUB_AGENT_DEPTH", "MAX_SUBAGENT_DEPTH", "maxSubAgentDepth"]) {
  test(`rejects obsolete or differently cased depth setting ${setting}`, () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-depth-casing-"));
    try {
      const configPath = writeConfig(directory, { [setting]: 1 });

      // Act / Assert: inherited policy must not silently accept an obsolete key either.
      for (const inheritedDepth of [undefined, 2]) {
        assert.throws(() => loadAgentShellConfig(directory, inheritedDepth), {
          message: `Invalid AgentShell configuration at ${configPath}: ` +
            `unknown setting "${setting}"`,
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const [setting, obsolete] of [
  ["max_output_bytes", "maxOutputBytes"],
  ["max_protocol_bytes", "maxProtocolBytes"],
  ["max_message_bytes", "maxMessageBytes"],
  ["max_stderr_bytes", "maxStderrBytes"],
] as const) {
  test(`loads snake_case ${setting} and rejects obsolete ${obsolete}`, () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-limit-casing-"));
    try {
      // Act / Assert: override each limit independently with a valid value.
      const value = setting === "max_protocol_bytes" ? 4 * 1024 * 1024 : 1024;
      const configPath = writeConfig(directory, { [setting]: value });
      assert.equal(loadAgentShellLimits(directory)[setting], value);

      writeFileSync(configPath, JSON.stringify({ [setting]: value, [obsolete]: value }));
      assert.throws(() => loadAgentShellConfig(directory), {
        message: `Invalid AgentShell configuration at ${configPath}: ` +
          `unknown setting "${obsolete}"`,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
