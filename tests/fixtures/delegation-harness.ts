import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../../index.ts";
import { closeAgentShellWorkers } from "../../runner.ts";

const directory = process.env.PI_CODING_AGENT_DIR!;
const configPath = join(directory, "extensions", "agentshell.json");
const fakeBin = fileURLToPath(new URL("../../python/tests/fixtures/bin/", import.meta.url));
const markerKeys = [
  "PI_AGENT_SHELL_CHILD", "PI_AGENT_SHELL_DEPTH", "PI_AGENT_SHELL_MAX_DEPTH",
] as const;

function markers(child?: string, depth?: string, max?: string): void {
  for (const [index, key] of markerKeys.entries()) {
    const value = [child, depth, max][index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadExtension() {
  const tools = new Map<string, ToolDefinition>();
  const startup: string[] = [];
  const messages: Array<{ content: string }> = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const shutdown: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler: () => Promise<void> }) {
      startup.push(name);
      commands.set(name, command);
    },
    appendEntry() {},
    registerMessageRenderer() { startup.push("renderer"); },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      startup.push(event);
      if (event === "session_shutdown") shutdown.push(handler);
    },
    sendMessage(message: { content: string }) { messages.push(message); },
    getActiveTools() { return [...tools.keys()]; },
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  await subagentsExtension(pi);
  return { tools, startup, messages, commands, shutdown };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for task completion");
    await delay(10);
  }
}

const context = {
  cwd: directory,
  mode: "tui",
  hasUI: true,
  isIdle: () => true,
  ui: {
    setWidget() {},
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
  },
} as unknown as Parameters<ToolDefinition["execute"]>[4];

function launch(tool: ToolDefinition, agentType: string) {
  return tool.execute("delegation-test", {
    agent_type: agentType, task_name: "Depth probe", prompt: "Report inherited depth",
  }, undefined, undefined, context);
}

export default async function delegationHarness(): Promise<void> {
  mkdirSync(join(directory, "extensions"), { recursive: true });
  const original = { ...process.env };
  try {
    const scenario = process.env.DELEGATION_SCENARIO!;
    if (/^(failure|cancel|preabort|shutdown)-/.test(scenario)) {
      // Arrange
      const [outcome, mode] = scenario.split("-");
      const started = join(directory, "started");
      markers();
      writeFileSync(configPath, "{}");
      process.env.PATH = fakeBin;
      process.env.FAKE_CODEX_STARTED_FILE = started;
      if (outcome === "failure") process.env.FAKE_CODEX_ERROR = "1";
      else process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = "10";
      const extension = await loadExtension();
      const controller = new AbortController();
      if (outcome === "preabort") controller.abort();
      const ctx = { ...context, mode, hasUI: false } as typeof context;

      // Act
      const execution = extension.tools.get("subagent")!.execute("direct-failure", {
        agent_type: "codex", task_name: "Failure", prompt: "Exercise failure handling",
      }, controller.signal, undefined, ctx);
      const expected = outcome === "failure" ? /fake agent failed[\s\S]*test response/
        : outcome === "shutdown" ? /exited|aborted/ : /aborted/;
      const rejected = assert.rejects(execution, expected);
      if (outcome === "cancel" || outcome === "shutdown") {
        await waitFor(() => existsSync(started));
        if (outcome === "cancel") controller.abort();
        else await extension.shutdown[0]({ type: "session_shutdown" }, ctx);
      }

      // Assert
      await rejected;
      if (outcome === "preabort") assert.equal(existsSync(started), false);
      assert.deepEqual(extension.messages, []);
      process.stderr.write("DELEGATION_HARNESS_OK\n");
      return;
    }

    if (process.env.DELEGATION_SCENARIO?.startsWith("completion-")) {
      // Arrange: a real worker that emits text before its delayed terminal result.
      const mode = process.env.DELEGATION_SCENARIO.slice("completion-".length);
      const direct = mode === "json" || mode === "print";
      const started = join(directory, "started");
      markers("1", "1", "1");
      writeFileSync(configPath, "{}");
      process.env.PATH = fakeBin;
      process.env.FAKE_CODEX_STARTED_FILE = started;
      process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = "0.3";
      const extension = await loadExtension();
      const notices: string[] = [];
      const ctx = {
        ...context, mode, hasUI: mode === "tui",
        ui: { ...context.ui, notify: (message: string) => notices.push(message) },
      } as typeof context;

      // Act
      let settled = false;
      const controller = new AbortController();
      const execution = extension.tools.get("subagent")!.execute("completion", {
        agent_type: "codex", task_name: "Wait", prompt: "Wait for the final result",
      }, controller.signal, undefined, ctx);
      void execution.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => existsSync(started));

      // Assert: print/json have no background job, including while still waiting.
      assert.equal(settled, !direct, `mode=${mode}`);
      if (direct) {
        await extension.commands.get("agentshell-jobs")!.handler("", ctx);
        assert.deepEqual(notices, ["No active subagent jobs."]);
      }
      const result = await execution;
      if (direct) {
        assert.equal(result.details.status, "ok");
        assert.equal(result.details.sessionId, "test-session");
        assert.equal(result.details.jobId, undefined);
        assert.match(result.content[0].text, /test response\n\nSession ID: test-session/);
        assert.deepEqual(extension.messages, []);
      } else {
        controller.abort(); // Parent-turn cancellation must not cancel background jobs.
        assert.equal(result.details.status, "running");
        assert.match(result.details.jobId, /^job-/);
        await waitFor(() => extension.messages.length === 1);
        assert.match(extension.messages[0].content, /Session ID: test-session/);
      }
      process.stderr.write("DELEGATION_HARNESS_OK\n");
      return;
    }

    if (process.env.DELEGATION_SCENARIO === "inheritance") {
      process.env.PATH = fakeBin;
      process.env.FAKE_AGENT_DEPTH_RESPONSE = "1";
      process.env.MAX_SUB_AGENT_DEPTH = "99"; // This is not a configuration override.
      for (const max of [0, 1, 2]) {
        // Arrange: each extension instance captures its root setting at startup.
        markers();
        writeFileSync(configPath, JSON.stringify(max === 0 ? {} : { MAX_SUB_AGENT_DEPTH: max }));
        const root = await loadExtension();
        writeFileSync(configPath, JSON.stringify({ MAX_SUB_AGENT_DEPTH: 99 }));
        const environment = { ...process.env };

        // Act: concurrent mixed targets must get the same root snapshot.
        await Promise.all([launch(root.tools.get("subagent")!, "pi"),
          launch(root.tools.get("subagent")!, "codex")]);
        await waitFor(() => root.messages.length === 2);

        // Assert
        for (const message of root.messages) {
          assert.ok(message.content.includes(`depth=1 max=${max} child=1`), message.content);
        }
        assert.deepEqual({ ...process.env }, environment);

        if (max > 0) {
          // The child's local depth setting is irrelevant, even if no longer valid.
          markers("1", "1", String(max));
          writeFileSync(configPath, '{"MAX_SUB_AGENT_DEPTH":null}');
          const child = await loadExtension();
          const notices: string[] = [];
          await child.commands.get("agentshell-roster")!.handler("", {
            ...context,
            ui: { ...context.ui, notify: (message: string) => notices.push(message) },
          });
          assert.deepEqual(notices, ["Subagent roster is now enabled."]);
          assert.ok(child.tools.has("subagent_roster"));
          await launch(child.tools.get("subagent")!, "pi");
          await waitFor(() => child.messages.length === 1);
          assert.ok(child.messages[0].content.includes(`depth=2 max=${max} child=1`));
        }
      }
      process.stderr.write("DELEGATION_HARNESS_OK\n");
      return;
    }

    if (process.env.DELEGATION_SCENARIO === "invalid") {
      // Arrange: broken JSON exposes any attempt at startup after an invalid marker.
      writeFileSync(configPath, "{");
      const invalid = [
        ["1"], ["1", "1"], ["1", undefined, "2"],
        [undefined, "1", "2"], [undefined, "1"], [undefined, undefined, "2"],
        ["0", "1", "2"], ["true", "1", "2"], ["", "1", "2"],
        ...["", "0", "-1", "1.5", "01", " 1", "1e0", "NaN", "9007199254740992"]
          .map((depth) => ["1", depth, "2"]),
        ...["", "-1", "1.5", "01", " 1", "1e0", "NaN", "9007199254740992"]
          .map((max) => ["1", "1", max]),
      ];
      for (const values of invalid) {
        markers(values[0], values[1], values[2]);
        // Act
        const result = await loadExtension();
        // Assert
        assert.equal(result.tools.size, 0, JSON.stringify(values));
        assert.deepEqual(result.startup, []);
      }
      process.stderr.write("DELEGATION_HARNESS_OK\n");
      return;
    }

    // Arrange: depth zero is the root, so it can always launch direct tasks.
    for (const max of [0, 1, 2]) {
      markers();
      writeFileSync(configPath, JSON.stringify({ MAX_SUB_AGENT_DEPTH: max }));
      const root = await loadExtension();
      assert.ok(root.tools.has("subagent"));

      for (let depth = 1; depth <= max + 1; depth++) {
        markers("1", String(depth), String(max));
        // A blocked descendant must return even before parsing a broken config file.
        writeFileSync(configPath, depth > max ? "{" : "{}");

        // Act
        const child = await loadExtension();

        // Assert
        assert.equal(child.tools.has("subagent"), depth <= max, `depth=${depth}, max=${max}`);
        if (depth > max) assert.deepEqual(child.startup, []);
      }
    }
    process.stderr.write("DELEGATION_HARNESS_OK\n");
  } finally {
    await closeAgentShellWorkers();
    for (const key of [
      ...markerKeys, "PATH", "FAKE_AGENT_DEPTH_RESPONSE", "MAX_SUB_AGENT_DEPTH",
      "FAKE_CODEX_STARTED_FILE", "FAKE_CODEX_RESULT_DELAY_SECONDS",
      "FAKE_CODEX_ERROR",
    ]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}
