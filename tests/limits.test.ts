import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadAgentShellLimits } from "../config.ts";
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
