import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HARNESS = join(
  ROOT,
  "tests",
  "fixtures",
  "silent-mode-harness.ts",
);

for (const silent of [false, true]) {
  test(`toggles and restores session output with global silent=${silent}`, {
    timeout: 15_000,
  }, () => {
    // Arrange: isolate the global config from the user's real settings.
    const agentDirectory = mkdtempSync(join(tmpdir(), "pi-agentshell-silent-"));
    mkdirSync(join(agentDirectory, "extensions"));
    if (silent) {
      writeFileSync(
        join(agentDirectory, "extensions", "agentshell.json"),
        JSON.stringify({ silent }),
      );
    }
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      SILENT_MODE_GLOBAL_DEFAULT: String(silent),
    };
    delete env.PI_AGENT_SHELL_CHILD;

    try {
      // Act: exercise the extension in a real Pi process.
      const completed = spawnSync(
        "pi",
        [
          "--mode",
          "rpc",
          "--offline",
          "--no-session",
          "--no-extensions",
          "--extension",
          HARNESS,
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          env,
          input: '{"type":"get_state","id":"silent-mode-test"}\n',
          timeout: 10_000,
        },
      );

      // Assert
      assert.equal(completed.error, undefined, completed.error?.message);
      assert.equal(
        completed.status,
        0,
        `stdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`,
      );
      assert.match(completed.stderr, /SILENT_MODE_COMMAND_OK/);
    } finally {
      rmSync(agentDirectory, { recursive: true, force: true });
    }
  });
}
