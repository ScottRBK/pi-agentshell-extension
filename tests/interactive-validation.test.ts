import assert from "node:assert/strict";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import {
  closeAgentShellWorkers,
  runAgentShell,
} from "../runner.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveTmuxExecutable(pathValue: string | undefined): string {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    const executable = join(directory, "tmux");
    try {
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // Continue searching PATH.
    }
  }

  throw new Error("tmux executable was not found on PATH");
}

function tmux(executable: string, socket: string, ...args: string[]) {
  return spawnSync(
    executable,
    ["-f", "/dev/null", "-S", socket, ...args],
    { encoding: "utf8", timeout: 5_000 },
  );
}

test("runs the real worker in an isolated pane and cleans a retained result", {
  timeout: 20_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-agentshell-validation-"));
  const bin = join(directory, "bin");
  const socket = join(directory, "tmux.sock");
  const session = `validation-${Date.now()}-${process.pid}`;
  const previousPath = process.env.PATH;
  const tmuxExecutable = resolveTmuxExecutable(previousPath);
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;

  mkdirSync(bin);
  const tmuxWrapper = join(bin, "tmux");
  writeFileSync(
    tmuxWrapper,
    "#!/bin/sh\n" +
      `exec ${shellQuote(tmuxExecutable)} -f /dev/null -S ` +
      `${shellQuote(socket)} "$@"\n`,
    "utf8",
  );
  chmodSync(tmuxWrapper, 0o755);

  const fakeCodex = join(bin, "codex");
  const visibleAnswer = '{"answer":"VISIBLE_VALIDATION_CODEX_926"}';
  const notifyTitle = '{"title":"NOT_VISIBLE_VALIDATION_CODEX_926"}';
  const notifyRoot = '{"root":"NOT_VISIBLE_VALIDATION_ROOT_926"}';
  writeFileSync(
    fakeCodex,
    "#!/usr/bin/env python3\n" +
      "import json, os, subprocess, sys, tomllib\n" +
      "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv " +
      "if arg.startswith('notify='))\n" +
      "assert all(os.isatty(fd) for fd in (0, 1, 2))\n" +
      `visible = '${visibleAnswer}'\n` +
      `title = '${notifyTitle}'\n` +
      `root = '${notifyRoot}'\n` +
      "print(visible, flush=True)\n" +
      "for record in (\n" +
      "    {'type': 'agent-turn-complete',\n" +
      "     'thread-id': 'notify-title-validation-session',\n" +
      "     'last-assistant-message': title},\n" +
      "    {'type': 'agent-turn-complete',\n" +
      "     'thread-id': 'notify-root-validation-session',\n" +
      "     'last-assistant-message': root},\n" +
      "):\n" +
      "    subprocess.run(notify + [json.dumps(record)], check=True)\n" +
      "input()\n",
    "utf8",
  );
  chmodSync(fakeCodex, 0o755);

  try {
    const started = tmux(
      tmuxExecutable,
      socket,
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "120",
      "-y",
      "40",
      "--",
      "sleep",
      "60",
    );
    assert.equal(started.status, 0, started.stderr);

    const parentPaneResult = tmux(
      tmuxExecutable,
      socket,
      "display-message",
      "-p",
      "-t",
      `${session}:0.0`,
      "#{pane_id}",
    );
    assert.equal(parentPaneResult.status, 0, parentPaneResult.stderr);
    const parentPane = parentPaneResult.stdout.trim();
    assert.match(parentPane, /^%\d+$/);

    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.TMUX = `${socket},0,0`;
    process.env.TMUX_PANE = parentPane;

    const result = await runAgentShell({
      agent_type: "codex",
      cwd: directory,
      prompt: "Return the validation answer without tools.",
      interactive: true,
      stay_open: true,
      inactivity_timeout: 1,
    });

    assert.match(
      result.output,
      new RegExp(`^Terminal capture \\(heuristic; may be incomplete\\):\\n${
        visibleAnswer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      }`),
    );
    assert.doesNotMatch(result.output, /NOT_VISIBLE_VALIDATION_CODEX_926/);
    assert.doesNotMatch(result.output, /NOT_VISIBLE_VALIDATION_ROOT_926/);
    assert.doesNotMatch(result.output, /notify-(?:title|root)-validation-session/);
    assert.equal(result.details.sessionId, undefined);
    assert.equal(result.details.warnings.length, 1);
    assert.match(
      result.details.warnings[0] ?? "",
      /Codex interactive uses interim terminal-capture mode/,
    );
    assert.equal(result.details.status, "ok");

    const retainedPanesResult = tmux(
      tmuxExecutable,
      socket,
      "list-panes",
      "-t",
      `${session}:0`,
      "-F",
      "#{pane_id}",
    );
    assert.equal(retainedPanesResult.status, 0, retainedPanesResult.stderr);
    const retainedPanes = retainedPanesResult.stdout.trim()
      .split(/\r?\n/).filter(Boolean);
    assert.equal(retainedPanes.length, 2);
    assert.ok(retainedPanes.includes(parentPane));

    await closeAgentShellWorkers();

    const remainingPanesResult = tmux(
      tmuxExecutable,
      socket,
      "list-panes",
      "-t",
      `${session}:0`,
      "-F",
      "#{pane_id}",
    );
    assert.equal(remainingPanesResult.status, 0, remainingPanesResult.stderr);
    const remainingPanes = remainingPanesResult.stdout.trim()
      .split(/\r?\n/).filter(Boolean);
    assert.deepEqual(remainingPanes, [parentPane]);
  } finally {
    await closeAgentShellWorkers();
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = previousTmux;
    }
    if (previousTmuxPane === undefined) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = previousTmuxPane;
    }
    tmux(tmuxExecutable, socket, "kill-server");
    rmSync(directory, { recursive: true, force: true });
  }
});
