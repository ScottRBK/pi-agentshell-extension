import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function runHarness(scenario: string): void {
  // Arrange: a real Pi loader, isolated config, and no model requests.
  const directory = mkdtempSync(join(tmpdir(), "pi-delegation-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory, DELEGATION_SCENARIO: scenario };
  delete env.PI_AGENT_SHELL_CHILD;
  delete env.PI_AGENT_SHELL_DEPTH;
  delete env.PI_AGENT_SHELL_MAX_DEPTH;
  try {
    // Act
    const result = spawnSync("pi", [
      "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
      "--extension", join(ROOT, "tests/fixtures/delegation-harness.ts"),
    ], {
      cwd: ROOT,
      env,
      input: '{"type":"get_state"}\n',
      encoding: "utf8",
      timeout: 20_000,
    });

    // Assert
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /DELEGATION_HARNESS_OK/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("depth 0/1/2 controls whole-extension availability before config startup", () => {
  runHarness("availability");
});

test("legacy, incomplete, and malformed internal markers disable all startup", () => {
  runHarness("invalid");
});

test("task launches inherit root depth limits across targets and config changes", () => {
  runHarness("inheritance");
});

for (const mode of ["json", "print", "tui", "rpc"]) {
  test(`${mode} parent delivers exactly once using its expected completion mode`, () => {
    runHarness(`completion-${mode}`);
  });
}

for (const mode of ["json", "print"]) {
  for (const outcome of ["failure", "cancel", "preabort", "shutdown"]) {
    test(`${mode} direct execution handles ${outcome} without a background delivery`, () => {
      runHarness(`${outcome}-${mode}`);
    });
  }
}
