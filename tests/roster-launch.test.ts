import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function runHarness(scenario: string): void {
  // Arrange: real Pi extension loader, disposable home, native process doubles only.
  const root = mkdtempSync(join(tmpdir(), "agentshell-roster-launch-"));
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"),
    PI_CODING_AGENT_DIR: root, ROSTER_SCENARIO: scenario };
  for (const key of ["PI_AGENT_SHELL_CHILD", "PI_AGENT_SHELL_DEPTH",
    "PI_AGENT_SHELL_MAX_DEPTH", "PI_AGENTSHELL_ROSTER_FILE", "TMUX", "TMUX_PANE"]) delete env[key];
  const socket = join(root, "tmux.sock");
  const tmux = spawnSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  const interactive = scenario === "interactive" || scenario === "resume-controls-interactive";
  try {
    if (interactive) {
      const server = spawnSync(tmux, ["-f", "/dev/null", "-S", socket,
        "new-session", "-d", "-s", "roster-test", "-x", "120", "-y", "40"], { encoding: "utf8" });
      assert.equal(server.status, 0, server.stderr);
      env.TMUX = `${socket},0,0`;
      env.TMUX_PANE = spawnSync(tmux, ["-S", socket, "display-message", "-p",
        "-t", "roster-test:0.0", "#{pane_id}"], { encoding: "utf8" }).stdout.trim();
      env.ROSTER_TMUX = tmux;
      env.ROSTER_SOCKET = socket;
    }
    // Act
    const result = spawnSync("pi", [
      "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
      "--extension", join(ROOT, "tests/fixtures/roster-launch-harness.ts"),
    ], { cwd: ROOT, env, encoding: "utf8", input: '{"type":"get_state"}\n', timeout: 20_000 });
    // Assert
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ROSTER_LAUNCH_OK/);
  } finally {
    if (interactive) spawnSync(tmux, ["-S", socket, "kill-server"]);
    rmSync(root, { recursive: true, force: true });
  }
}

test("launches a named roster entry and rejects unknown or conflicting settings", () => {
  runHarness("named");
});

test("non-Pi named/ad-hoc calls reject child rosters before jobs or native launch", () => {
  runHarness("nonpi");
});

test("concurrent children scope rosters and retain depth policy", () => {
  runHarness("scoping");
});

test("named/ad-hoc resources reach the worker; invalid choices fail", () => {
  runHarness("resources");
});

test("recorded plain ad-hoc resumes keep explicit model, effort and operational controls", () => {
  runHarness("adhoc-resume");
});

test("named/ad-hoc resumes default to no approval when auto_approve is omitted", () => {
  runHarness("resume-approval");
});

test("named/ad-hoc resumes omit old tool lists and never inherit the opposite list", () => {
  runHarness("resume-tools");
});

test("interactive resumes ignore previous headless-only approval and tool controls", () => {
  runHarness("resume-controls-interactive");
});

test("ad-hoc resource resumes preserve resources and cwd, not model or effort", () => {
  runHarness("resource-resume");
});

test("native sessions retain launch settings across parent reloads", () => {
  runHarness("resume");
});

test("resume rejects Job IDs and unrecorded selected roles but keeps legacy ad-hoc calls", () => {
  runHarness("resume-invalid");
});

test("interactive resources reach the worker; retained results are not stopped", () => {
  runHarness("interactive");
});

test("resuming a selected entry explains when its original roster is disabled", () => {
  runHarness("disabled-resume");
});

test("tree navigation cannot discard known role/child-roster contracts or pin ad-hoc calls", () => {
  runHarness("tree-evade");
});

test("session_tree adds branch records while session_start still rebuilds from its branch", () => {
  runHarness("branch");
});

test("background completion saves the native session's role, not its Job ID", () => {
  runHarness("background");
});
