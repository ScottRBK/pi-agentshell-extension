import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import extension from "../../index.ts";
import { closeAgentShellWorkers } from "../../runner.ts";

const root = process.env.PI_CODING_AGENT_DIR!;
const rosterPath = join(root, "role/roster.json");
const globalPath = join(root, "extensions/agentshell.json");
const started = join(root, "started");
const role = { name: "owner", description: "Implement a feature", agent_type: "pi",
  model: "test-model", effort: "high", cwd: "./work" };
const history: any[] = [];
const context = {
  cwd: root, mode: "json", hasUI: false, isIdle: () => true,
  sessionManager: { getBranch: () => history },
  ui: { setWidget() {}, notify() {} },
} as unknown as Parameters<ToolDefinition["execute"]>[4];

async function load() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  await extension({
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer() {},
    on(name: string, handler: any) { handlers.set(name, handler); },
    appendEntry(customType: string, data: unknown) {
      history.push({ type: "custom", customType, data });
    },
    sendMessage(message: any) { messages.push(message); },
    getActiveTools: () => [...tools.keys()], setActiveTools() {},
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({}, context);
  return { tools, commands, messages, handlers };
}

function launch(tools: Map<string, ToolDefinition>, params: object, mode = context.mode) {
  return tools.get("subagent")!.execute("roster-call", {
    task_name: "Feature", prompt: "Implement it", ...params,
  }, undefined, undefined, { ...context, mode });
}

function report(result: any) {
  const text = result.content[0].text;
  return JSON.parse(text.slice(0, text.lastIndexOf("\n\nSession ID:")));
}

export default async function rosterLaunchHarness(): Promise<void> {
  const original = { ...process.env };
  try {
    mkdirSync(join(root, "extensions"));
    mkdirSync(join(root, "role/work"), { recursive: true });
    mkdirSync(join(root, "bin"));
    const fakePi = join(root, "bin/pi");
    copyFileSync(fileURLToPath(new URL("roster-agent.py", import.meta.url)), fakePi);
    chmodSync(fakePi, 0o755);
    writeFileSync(globalPath, '{"max_sub_agent_depth":2}');
    writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [role] } }));
    process.env.PATH = join(root, "bin");
    process.env.PI_AGENTSHELL_ROSTER_FILE = rosterPath;
    process.env.ROSTER_STARTED = started;
    if (process.env.ROSTER_SCENARIO === "null-roster-schema") {
      // Arrange: inspect the actual schema exposed to callers, without coercion.
      const { tools } = await load();
      const schema = tools.get("subagent")!.parameters;
      const base = { agent_type: "pi", task_name: "Review", prompt: "Review it" };
      // Act / Assert
      for (const selection of [{}, { roster_file: null }, { roster_file: "child.json" }]) {
        assert.equal(Value.Check(schema, { ...base, ...selection }), true,
          `schema should accept ${JSON.stringify(selection)}`);
      }
      for (const roster_file of ["", 42, false, {}, []]) {
        assert.equal(Value.Check(schema, { ...base, roster_file }), false);
      }
      const description = schema.properties.roster_file.description;
      assert.match(description, /omit.*null/i);
      assert.match(description, /non-Pi/i);
      assert.match(description, /placeholder/i);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "null-roster") {
      // Arrange: real worker/adapters, with only the external native agents replaced.
      const fakeCopilot = join(root, "bin/copilot");
      copyFileSync(fileURLToPath(new URL("roster-copilot.py", import.meta.url)), fakeCopilot);
      chmodSync(fakeCopilot, 0o755);
      const childPath = join(root, "role/child.json");
      writeFileSync(childPath, '{"roster":{"enabled":false}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [role,
        { ...role, name: "reviewer", agent_type: "copilot_cli" },
        { ...role, name: "parent", roster_file: "child.json" },
      ] } }));
      const { tools, messages } = await load();
      // Act / Assert: omission and null have identical native launch settings.
      for (const selection of [{ agent_type: "copilot_cli" }, { roster_entry: "reviewer" },
        { agent_type: "pi" }, { roster_entry: "owner" }, { roster_entry: "parent" }]) {
        const omitted = await launch(tools, selection);
        const nullable = await launch(tools, { ...selection, roster_file: null });
        assert.equal(nullable.details.status, "ok");
        assert.deepEqual(report(nullable), report(omitted));
        assert.equal(report(nullable).roster,
          selection.roster_entry === "parent" ? childPath : null);
        // Rebuild from persisted launch records, just as a parent reload does.
        const restored = await load();
        const resume = { resume_session_id: nullable.details.sessionId };
        const normal = await launch(restored.tools, resume);
        const withNull = await launch(restored.tools, { ...resume, roster_file: null });
        assert.equal(withNull.details.status, "ok");
        assert.deepEqual(report(withNull), report(normal));
        assert.ok(report(withNull).args.includes(nullable.details.sessionId));
      }
      // Null must preserve an ad-hoc saved child roster, not overwrite it on resume.
      const first = await launch(tools, { agent_type: "pi", roster_file: childPath });
      const restored = await load();
      const resumed = await launch(restored.tools, {
        resume_session_id: first.details.sessionId, roster_file: null,
      });
      assert.equal(report(resumed).roster, childPath);
      // Legacy unrecorded ad-hoc sessions still allow null just like omission.
      const legacy = await launch(tools, { agent_type: "pi",
        resume_session_id: "legacy-native-session", roster_file: null });
      assert.ok(report(legacy).args.includes("legacy-native-session"));
      rmSync(started);
      for (const mode of ["json", "rpc"] as const) {
        for (const selection of [{ agent_type: "copilot_cli" }, { roster_entry: "reviewer" }]) {
          await assert.rejects(launch(tools, { ...selection, roster_file: "x" }, mode),
            /roster_file is supported only for agent_type "pi"/);
          assert.equal(existsSync(started), false);
          assert.equal(messages.length, 0);
        }
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "null-resources-schema") {
      // Arrange
      const { tools } = await load();
      const schema = tools.get("subagent")!.parameters;
      const base = { agent_type: "pi", task_name: "Review", prompt: "Review it" };
      // Act / Assert
      for (const selection of [{}, { resources: null }, { resources: {} },
        { resources: { skills: ["skill.md"], mcp_servers: null } }]) {
        assert.equal(Value.Check(schema, { ...base, ...selection }), true,
          `schema should accept ${JSON.stringify(selection)}`);
      }
      for (const resources of ["", 42, false, [], { unknown: true },
        { packages: ["package"] }, { skills: [""] }]) {
        assert.equal(Value.Check(schema, { ...base, resources }), false);
      }
      assert.match(schema.properties.resources.description, /omit.*null/i);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "null-resources") {
      // Arrange
      const fakeCopilot = join(root, "bin/copilot");
      copyFileSync(fileURLToPath(new URL("roster-copilot.py", import.meta.url)), fakeCopilot);
      chmodSync(fakeCopilot, 0o755);
      const skillPath = join(root, "role/skill.md");
      writeFileSync(skillPath, "# Review skill");
      const piResources = { skills: [skillPath] };
      const copilotResources = { include_instruction_files: false };
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [role,
        { ...role, name: "reviewer", agent_type: "copilot_cli" },
        { ...role, name: "skilled", resources: piResources },
        { ...role, name: "isolated", agent_type: "copilot_cli", resources: copilotResources },
      ] } }));
      const { tools } = await load();
      // Act / Assert: null is neither an empty selection nor a request to clear a role.
      for (const selection of [{ agent_type: "copilot_cli" }, { roster_entry: "reviewer" },
        { agent_type: "pi" }, { roster_entry: "owner" },
        { roster_entry: "skilled" }, { roster_entry: "isolated" }]) {
        const omitted = await launch(tools, selection);
        const nullable = await launch(tools, { ...selection, resources: null, roster_file: null });
        assert.equal(nullable.details.status, "ok");
        assert.deepEqual(report(nullable), report(omitted));
        const restored = await load();
        const resume = { resume_session_id: nullable.details.sessionId };
        const normal = await launch(restored.tools, resume);
        const withNull = await launch(restored.tools, {
          ...resume, resources: null, roster_file: null,
        });
        assert.deepEqual(report(withNull), report(normal));
        assert.ok(report(withNull).args.includes(nullable.details.sessionId));
      }
      // Ad-hoc resource selections must also survive null on resume after a reload.
      for (const [agent_type, resources, expectedArg] of [
        ["pi", piResources, skillPath],
        ["copilot_cli", copilotResources, "--no-custom-instructions"],
      ] as const) {
        const first = await launch(tools, { agent_type, resources });
        const restored = await load();
        const resumed = await launch(restored.tools, {
          resume_session_id: first.details.sessionId, resources: null, roster_file: null,
        });
        assert.ok(report(resumed).args.includes(expectedArg));
        rmSync(started);
        await assert.rejects(launch(restored.tools, {
          resume_session_id: first.details.sessionId, resources: {},
        }), /resources/);
        assert.equal(existsSync(started), false);
      }
      const legacy = await launch(tools, { agent_type: "copilot_cli",
        resume_session_id: "legacy-copilot-session", resources: null, roster_file: null });
      assert.ok(report(legacy).args.includes("legacy-copilot-session"));
      rmSync(started);
      for (const roster_entry of ["reviewer", "skilled", "isolated"]) {
        await assert.rejects(launch(tools, { roster_entry, resources: {} }),
          /Manual resources conflicts/);
        assert.equal(existsSync(started), false);
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "nonpi") {
      const fakeCodex = join(root, "bin/codex");
      copyFileSync(fileURLToPath(new URL("roster-codex.py", import.meta.url)), fakeCodex);
      chmodSync(fakeCodex, 0o755);
      const fakeClaude = join(root, "bin/claude");
      copyFileSync(fileURLToPath(new URL("roster-claude.py", import.meta.url)), fakeClaude);
      chmodSync(fakeClaude, 0o755);
      mkdirSync(join(root, "role/plugin"));
      const childPath = join(root, "role/child.json");
      writeFileSync(childPath, '{"roster":{"enabled":false}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [role,
        { ...role, name: "reviewer", agent_type: "codex", resources: {} },
        { ...role, name: "claude-reviewer", agent_type: "claude_code",
          resources: { plugins: ["plugin"], mcp_servers: [] } },
      ] } }));
      const { tools, messages } = await load();
      // Act / Assert: reject at the registered tool, even in background mode.
      for (const mode of ["json", "rpc"] as const) {
        for (const selection of [{ agent_type: "codex" }, { roster_entry: "reviewer" },
          { agent_type: "claude_code" }, { roster_entry: "claude-reviewer" }]) {
          await assert.rejects(launch(tools, { ...selection, roster_file: childPath }, mode),
            /roster_file.*only.*pi/i);
          assert.equal(existsSync(started), false);
          assert.equal(messages.length, 0);
        }
      }
      // Ordinary mixed-harness selections and supported default resources still launch.
      assert.equal(report(await launch(tools, { roster_entry: "reviewer" })).roster, null);
      assert.equal(report(await launch(tools, { agent_type: "codex", resources: {} })).roster,
        null);
      for (const selection of [{ roster_entry: "claude-reviewer" }, { agent_type: "claude_code",
        resources: { plugins: [join(root, "role/plugin")], mcp_servers: [] } }]) {
        const child = report(await launch(tools, selection));
        assert.ok(child.args.includes("--plugin-dir"));
        assert.ok(child.args.includes(join(root, "role/plugin")));
        assert.ok(child.args.includes("--strict-mcp-config"));
        assert.deepEqual(child.mcp, { mcpServers: {} });
        assert.equal(child.roster, null);
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "scoping") {
      writeFileSync(join(root, "role/a.json"), '{"roster":{"enabled":false}}');
      writeFileSync(join(root, "role/b.json"), '{"roster":{"enabled":true}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [
        { ...role, roster_file: "a.json" },
        { ...role, name: "plain" },
        { ...role, name: "other", roster_file: "b.json" },
      ] } }));
      process.env.PI_AGENT_SHELL_CHILD = "1";
      process.env.PI_AGENT_SHELL_DEPTH = "1";
      process.env.PI_AGENT_SHELL_MAX_DEPTH = "1";
      writeFileSync(globalPath, '{"max_sub_agent_depth":99}');
      const { tools, commands } = await load();
      const environment = { ...process.env };
      const selectedText = readFileSync(rosterPath, "utf8");
      // Act
      const results = await Promise.all(["owner", "plain", "other"].map(
        (name) => launch(tools, { roster_entry: name }),
      ));
      const adHoc = report(await launch(tools, { agent_type: "pi" }));
      await commands.get("agentshell-roster").handler("", context);
      // Assert
      assert.deepEqual(results.map((result) => report(result).roster), [
        join(root, "role/a.json"), null, join(root, "role/b.json"),
      ]);
      assert.equal(adHoc.roster, null);
      for (const result of results) {
        assert.equal(report(result).depth, "2");
        assert.equal(report(result).maxDepth, "1");
      }
      assert.deepEqual({ ...process.env }, environment);
      assert.equal(readFileSync(globalPath, "utf8"), '{"max_sub_agent_depth":99}');
      assert.equal(readFileSync(rosterPath, "utf8"), selectedText);
      await assert.rejects(launch(tools, { roster_entry: "owner" }), /disabled/);
      process.env.PI_AGENT_SHELL_DEPTH = "2";
      process.env.PI_AGENTSHELL_ROSTER_FILE = join(root, "missing.json");
      assert.equal((await load()).tools.size, 0);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "disabled-resume") {
      const { tools, commands } = await load();
      const first = await launch(tools, { roster_entry: "owner" });
      rmSync(started);
      // Act
      await commands.get("agentshell-roster").handler("", context);
      // Assert: the caller supplied only an ID, not an unknown entry name.
      await assert.rejects(launch(tools, { resume_session_id: first.details.sessionId }),
        (error: Error) => {
          assert.match(error.message, /original.*owner.*disabled/i);
          assert.doesNotMatch(error.message, /unknown/i);
          return true;
        });
      assert.equal(existsSync(started), false);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "tree-evade") {
      // Arrange: a child roster without SessionResources; no upstream digest can mask this bug.
      const childPath = join(root, "role/child.json");
      writeFileSync(childPath, '{"roster":{"enabled":false}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true,
        roles: [{ ...role, roster_file: "child.json" }] } }));
      const { tools, handlers } = await load();
      const first = await launch(tools, { roster_entry: "owner" });
      const sessionId = first.details.sessionId;
      const plain = await launch(tools, { agent_type: "pi", model: "ad-hoc-one" });
      rmSync(started);
      // Act: navigate away from every launch record without reloading the extension.
      history.length = 0;
      await handlers.get("session_tree")?.({ type: "session_tree",
        oldLeafId: "selected", newLeafId: "other" }, context);
      // Assert: explicit ad-hoc syntax cannot discard this runtime's known role contract.
      for (const change of [{ model: "different", cwd: root }, { cwd: root },
        { roster_file: rosterPath }]) {
        await assert.rejects(launch(tools, { agent_type: "pi", resume_session_id: sessionId,
          ...change }), /conflict|original/i);
        assert.equal(existsSync(started), false);
      }
      const child = report(await launch(tools, { resume_session_id: sessionId }));
      assert.equal(child.cwd, join(root, "role/work"));
      assert.equal(child.roster, childPath);
      assert.ok(child.args.includes("test-model"));
      assert.ok(!child.args.includes("--no-skills"));
      const adHoc = report(await launch(tools, { resume_session_id: plain.details.sessionId,
        agent_type: "pi", model: "ad-hoc-two", effort: "low", cwd: join(root, "role"),
      }));
      assert.equal(adHoc.cwd, join(root, "role"));
      assert.equal(adHoc.roster, null);
      assert.ok(adHoc.args.includes("ad-hoc-two"));
      assert.ok(adHoc.args.includes("low"));
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "branch") {
      // Arrange: a new runtime starts on a branch without the earlier launch record.
      const initial = await load();
      const first = await launch(initial.tools, { roster_entry: "owner" });
      const sessionId = first.details.sessionId;
      const selectedBranch = [...history];
      history.length = 0;
      const { tools, handlers } = await load();
      rmSync(started);
      await assert.rejects(launch(tools, { resume_session_id: sessionId, roster_entry: "owner" }),
        /recorded|original/);
      assert.equal(existsSync(started), false);
      // Act: visiting the saved branch makes its previously unknown record available.
      history.push(...selectedBranch);
      await handlers.get("session_tree")?.({ type: "session_tree",
        oldLeafId: "other", newLeafId: "selected" }, context);
      const child = report(await launch(tools, { resume_session_id: sessionId }));
      // Assert
      assert.equal(child.cwd, join(root, "role/work"));
      assert.ok(child.args.includes("test-model"));
      assert.ok(child.args.includes(sessionId));
      // Unlike tree navigation, session_start still rebuilds only from its current branch.
      history.length = 0;
      await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
      rmSync(started);
      await assert.rejects(launch(tools, { resume_session_id: sessionId, roster_entry: "owner" }),
        /recorded|original/);
      assert.equal(existsSync(started), false);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "background") {
      const initial = await load();
      // Act
      const job = await launch(initial.tools, { roster_entry: "owner" }, "rpc");
      const deadline = Date.now() + 5_000;
      while (initial.messages.length === 0) {
        assert.ok(Date.now() < deadline, "background completion timed out");
        await delay(10);
      }
      const sessionId = initial.messages[0].content.match(/Session ID: (.+)$/)?.[1];
      const restored = await load();
      const child = report(await launch(restored.tools, { resume_session_id: sessionId }));
      // Assert
      assert.match(job.details.jobId, /^job-/);
      assert.ok(sessionId && sessionId !== job.details.jobId);
      assert.equal(child.cwd, join(root, "role/work"));
      assert.ok(child.args.includes("test-model"));
      assert.ok(child.args.includes(sessionId));
      assert.equal(initial.messages.length, 1);
      rmSync(started);
      await assert.rejects(
        launch(restored.tools, { roster_entry: "owner", model: "conflict" }, "rpc"),
        /conflict/);
      assert.equal(existsSync(started), false);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "interactive") {
      writeFileSync(join(root, "bin/tmux"),
        `#!/bin/sh\nexec '${process.env.ROSTER_TMUX}' -f /dev/null `
        + `-S '${process.env.ROSTER_SOCKET}' "$@"\n`, { mode: 0o755 });
      writeFileSync(join(root, "role/skill.md"), "# Interactive skill");
      writeFileSync(join(root, "role/child.json"), '{"roster":{"enabled":false}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [{ ...role,
        roster_file: "child.json", resources: { skills: ["skill.md"], mcp_servers: [],
          inherit_personal_resources: false, inherit_project_resources: false },
      }] } }));
      const { tools, handlers } = await load();
      // Act: keep the real pane/process alive after its first result.
      const result = await launch(tools, {
        roster_entry: "owner", interactive: true, stay_open: true,
      });
      const child = report(result);
      // Assert
      assert.ok(child.args.includes(join(root, "role/skill.md")));
      assert.ok(child.args.includes("--no-skills"));
      assert.ok(child.args.includes("--no-mcp"));
      assert.equal(child.roster, join(root, "role/child.json"));
      assert.equal(child.home, root);
      assert.equal(child.depth, "1");
      assert.equal(child.maxDepth, "2");
      assert.ok(result.details.sessionId);
      rmSync(started);
      await assert.rejects(launch(tools, { resume_session_id: result.details.sessionId }),
        /still be running|retained/i);
      assert.equal(existsSync(started), false);
      await assert.rejects(launch(tools, { resume_session_id: result.details.sessionId,
        interactive: false, stay_open: false }), /still be running|retained/i);
      const retainedBranch = [...history];
      history.length = 0;
      await handlers.get("session_tree")?.({ type: "session_tree",
        oldLeafId: "retained", newLeafId: "other" }, context);
      await assert.rejects(launch(tools, { resume_session_id: result.details.sessionId,
        agent_type: "pi", interactive: false }), /still be running|retained/i);
      assert.equal(existsSync(started), false);
      history.push(...retainedBranch);
      await handlers.get("session_tree")?.({ type: "session_tree",
        oldLeafId: "other", newLeafId: "retained" }, context);
      const closed = await launch(tools, { roster_entry: "owner", interactive: true });
      const resumed = report(await launch(tools, { resume_session_id: closed.details.sessionId,
        interactive: false, auto_approve: true, inactivity_timeout: 120,
      }));
      assert.ok(resumed.args.includes(closed.details.sessionId));
      assert.ok(resumed.args.includes(join(root, "role/skill.md")));
      assert.equal(resumed.roster, join(root, "role/child.json"));
      assert.ok(resumed.args.includes("--approve"));
      const reopened = report(await launch(tools, { resume_session_id: closed.details.sessionId,
        interactive: true, auto_approve: false, inactivity_timeout: 30, inactivity_enabled: false,
      }));
      assert.ok(reopened.args.includes("--no-skills"));
      const plain = await launch(tools, { agent_type: "pi" });
      const plainUI = await launch(tools, { resume_session_id: plain.details.sessionId,
        interactive: true, stay_open: false });
      assert.ok(report(plainUI).args.includes(plain.details.sessionId));
      const plainHeadless = await launch(tools, { resume_session_id: plain.details.sessionId,
        interactive: false, auto_approve: true });
      assert.ok(report(plainHeadless).args.includes("--approve"));
      // Native IDs are scoped to their harness; an unrelated Codex ID may have the same text.
      const fakeCodex = join(root, "bin/codex");
      copyFileSync(fileURLToPath(new URL("roster-codex.py", import.meta.url)), fakeCodex);
      chmodSync(fakeCodex, 0o755);
      process.env.ROSTER_SESSION_ID = result.details.sessionId;
      const codex = await launch(tools, { agent_type: "codex" });
      assert.equal(codex.details.sessionId, result.details.sessionId);
      const codexResume = report(await launch(tools, { agent_type: "codex",
        resume_session_id: codex.details.sessionId }));
      assert.ok(codexResume.args.includes(codex.details.sessionId));
      await assert.rejects(launch(tools, { agent_type: "pi",
        resume_session_id: result.details.sessionId }), /still be running|retained/i);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resume-invalid") {
      const { tools } = await load();
      // Act / Assert
      for (const resume_session_id of ["new", "job-123"]) {
        await assert.rejects(
          launch(tools, { agent_type: "pi", resume_session_id }), /native|Session/,
        );
        assert.equal(existsSync(started), false);
      }
      await assert.rejects(
        launch(tools, { roster_entry: "owner", resume_session_id: "unrecorded" }),
        /recorded|original/);
      assert.equal(existsSync(started), false);
      const legacy = report(await launch(tools, {
        agent_type: "pi", resume_session_id: "legacy-native-session",
      }));
      assert.ok(legacy.args.includes("legacy-native-session"));
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "adhoc-resume") {
      const initial = await load();
      const first = await launch(initial.tools, { agent_type: "pi", model: "review-model",
        effort: "low", auto_approve: false });
      const sessionId = first.details.sessionId;
      assert.ok(sessionId);
      // Replay the same persisted records that the initial implementation wrote.
      const restored = await load();
      // Act: review -> fix is an ordinary explicit call, not an immutable selected role.
      const child = report(await launch(restored.tools, { resume_session_id: sessionId,
        agent_type: "pi", model: "fix-model", effort: "high", auto_approve: true,
        allowed_tools: ["read", "edit"], disallowed_tools: ["bash"], cwd: join(root, "role"),
        inactivity_timeout: 120, inactivity_enabled: false, stay_open: true,
      }));
      // Assert: explicit arguments, including headless-irrelevant options, remain accepted.
      assert.equal(child.cwd, join(root, "role"));
      for (const arg of [sessionId, "fix-model", "high", "--approve", "read,edit"]) {
        assert.ok(child.args.includes(arg), arg);
      }
      assert.equal(child.roster, null);
      const next = report(await launch(restored.tools, { resume_session_id: sessionId,
        auto_approve: false, allowed_tools: ["read"], disallowed_tools: ["write"],
      }));
      assert.ok(next.args.includes("--no-approve"));
      assert.ok(next.args.includes("read"));
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resume-approval") {
      for (const selection of [{ roster_entry: "owner" }, { agent_type: "pi" }]) {
        // Arrange: persist a successful opt-in, including the legacy snapshot fields.
        const initial = await load();
        const first = await launch(initial.tools, { ...selection, auto_approve: true });
        assert.ok(report(first).args.includes("--approve"));
        const restored = await load();
        // Act: approval was not requested for this invocation.
        const child = report(await launch(restored.tools, {
          resume_session_id: first.details.sessionId,
        }));
        // Assert: replaying a prior launch must not restore its approval opt-in.
        assert.ok(!child.args.includes("--approve"));
        assert.ok(child.args.includes("--no-approve"));
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resume-tools") {
      for (const selection of [{ roster_entry: "owner" }, { agent_type: "pi" }]) {
        // Arrange
        const initial = await load();
        const first = await launch(initial.tools, { ...selection,
          allowed_tools: ["read"], disallowed_tools: ["bash"],
        });
        assert.ok(report(first).args.includes("--tools"));
        assert.ok(report(first).args.includes("--exclude-tools"));
        const restored = await load();
        const resume = { resume_session_id: first.details.sessionId };
        // Act / Assert: omission clears both lists, with no new clearing argument.
        const omitted = report(await launch(restored.tools, resume));
        assert.ok(!omitted.args.includes("--tools"));
        assert.ok(!omitted.args.includes("--exclude-tools"));
        await launch(restored.tools, { ...resume, disallowed_tools: ["bash"] });
        const allowed = report(await launch(restored.tools, { ...resume,
          allowed_tools: ["read"],
        }));
        assert.ok(allowed.args.includes("--tools"));
        assert.ok(allowed.args.includes("read"));
        assert.ok(!allowed.args.includes("--exclude-tools"));
        const denied = report(await launch(restored.tools, { ...resume,
          disallowed_tools: ["bash"],
        }));
        assert.ok(denied.args.includes("--exclude-tools"));
        assert.ok(denied.args.includes("bash"));
        assert.ok(!denied.args.includes("--tools"));
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resume-controls-interactive") {
      // Arrange: real AgentShell/tmux, isolated socket and native process double only.
      writeFileSync(join(root, "bin/tmux"),
        `#!/bin/sh\nexec '${process.env.ROSTER_TMUX}' -f /dev/null `
        + `-S '${process.env.ROSTER_SOCKET}' "$@"\n`, { mode: 0o755 });
      writeFileSync(join(root, "role/skill.md"), "# Skill");
      const childPath = join(root, "role/child.json");
      writeFileSync(childPath, '{"roster":{"enabled":false}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [{ ...role,
        roster_file: "child.json", resources: { skills: ["skill.md"], mcp_servers: [],
          inherit_personal_resources: false, inherit_project_resources: false },
      }] } }));
      const { tools } = await load();
      for (const selection of [{ roster_entry: "owner" }, { agent_type: "pi" }]) {
        for (const controls of [{ auto_approve: true }, { allowed_tools: ["read"] },
          { disallowed_tools: ["bash"] }]) {
          const first = await launch(tools, { ...selection, ...controls });
          const resume = { resume_session_id: first.details.sessionId, interactive: true };
          // Act: only the previous headless call supplied permission/tool flags.
          const child = report(await launch(tools, resume));
          // Assert: the interactive native process runs without those old flags.
          for (const flag of ["--mode", "--approve", "--tools", "--exclude-tools"]) {
            assert.ok(!child.args.includes(flag), flag);
          }
          assert.ok(child.args.includes(first.details.sessionId));
          if ("roster_entry" in selection) {
            assert.ok(child.args.includes("--no-skills"));
            assert.equal(child.roster, childPath);
            assert.equal(child.cwd, join(root, "role/work"));
          }
          rmSync(started);
          // Current-call unsupported controls are still checked, not discarded.
          await assert.rejects(launch(tools, { ...resume, ...controls }),
            /auto_approve|allowed_tools|disallowed_tools/);
          assert.equal(existsSync(started), false);
        }
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resource-resume") {
      writeFileSync(join(root, "role/skill.md"), "# Skill");
      const { tools } = await load();
      const first = await launch(tools, { agent_type: "pi", cwd: join(root, "role"),
        model: "review-model", effort: "low", resources: { skills: ["skill.md"],
          inherit_personal_resources: false, inherit_project_resources: false, mcp_servers: [] },
      });
      const sessionId = first.details.sessionId;
      // Act: resource continuity does not freeze ad-hoc model/effort or approval controls.
      const child = report(await launch(tools, { resume_session_id: sessionId,
        model: "fix-model", effort: "high", auto_approve: true, allowed_tools: ["read", "edit"],
      }));
      // Assert
      for (const arg of [sessionId, "fix-model", "high", "--approve", "--no-skills",
        join(root, "role/skill.md")]) assert.ok(child.args.includes(arg), arg);
      assert.equal(child.cwd, join(root, "role"));
      rmSync(started);
      for (const change of [{ cwd: root }, { resources: {} }, { agent_type: "codex" }]) {
        await assert.rejects(launch(tools, { resume_session_id: sessionId, ...change }),
          (error: Error) => {
            assert.ok(error.message.includes(Object.keys(change)[0]), error.message);
            assert.ok(!error.message.includes(root), "conflicts must not dump configuration");
            return true;
          });
        assert.equal(existsSync(started), false);
      }
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resume") {
      writeFileSync(join(root, "role/skill.md"), "# Original content");
      const childPath = join(root, "role/child.json");
      writeFileSync(childPath, '{"roster":{"enabled":false}}');
      const selectedRole = { ...role, roster_file: "child.json", resources: {
        skills: ["./skill.md"], mcp_servers: [], inherit_personal_resources: false,
        inherit_project_resources: false,
      } };
      writeFileSync(rosterPath, JSON.stringify({
        roster: { enabled: true, roles: [selectedRole] },
      }));
      const initial = await load();
      const first = await launch(initial.tools, { roster_entry: "owner", auto_approve: true });
      const sessionId = first.details.sessionId;
      assert.ok(sessionId);
      writeFileSync(globalPath, '{"interactive":{"enabled":true}}');
      const restored = await load();
      // Act: only the returned native session ID and a new task are needed.
      const resumed = await launch(restored.tools, { resume_session_id: sessionId });
      const child = report(resumed);
      // Assert: global defaults and the caller's cwd do not silently change the role.
      assert.equal(child.cwd, join(root, "role/work"));
      assert.equal(child.roster, childPath);
      assert.ok(child.args.includes("test-model"));
      assert.ok(child.args.includes("high"));
      assert.ok(child.args.includes("--no-skills"));
      assert.ok(child.args.includes(join(root, "role/skill.md")));
      assert.ok(child.args.includes("--session-id"));
      assert.ok(child.args.includes(sessionId));
      assert.ok(child.args.includes("--no-approve"));
      assert.ok(!child.args.includes("--approve"));
      rmSync(started);
      for (const settings of [
        { model: "different" }, { agent_type: "codex" }, { effort: "low" },
        { cwd: root }, { roster_entry: "other" }, { resources: {} },
        { roster_file: rosterPath },
      ]) {
        await assert.rejects(launch(restored.tools, { resume_session_id: sessionId, ...settings }),
          /conflict|original|roster entry/i);
        assert.equal(existsSync(started), false);
      }
      // Operational controls are per-call choices, not roster-defined fields.
      const controlled = report(await launch(restored.tools, { resume_session_id: sessionId,
        auto_approve: false, allowed_tools: ["read"], disallowed_tools: ["bash"],
        interactive: false, inactivity_timeout: 120, inactivity_enabled: false,
      }));
      assert.ok(controlled.args.includes("--no-approve"));
      assert.ok(controlled.args.includes("--tools"));
      assert.ok(controlled.args.includes("read"));
      assert.ok(controlled.args.includes("--no-skills"));
      assert.equal(controlled.roster, childPath);
      // Resource contents are intentionally not frozen by a selection/digest.
      writeFileSync(join(root, "role/skill.md"), "# Updated content at the same selected path");
      await launch(restored.tools, { resume_session_id: sessionId });
      rmSync(started);
      const alternatePath = join(root, "role/alternate.json");
      copyFileSync(rosterPath, alternatePath);
      process.env.PI_AGENTSHELL_ROSTER_FILE = alternatePath;
      const alternate = await load();
      await assert.rejects(launch(alternate.tools, { resume_session_id: sessionId }),
        /roster source/i);
      assert.equal(existsSync(started), false);
      process.env.PI_AGENTSHELL_ROSTER_FILE = rosterPath;
      writeFileSync(childPath, '{"roster":{"enabled":true}}');
      await assert.rejects(
        launch(restored.tools, { resume_session_id: sessionId }), /roster_file contents/i,
      );
      assert.equal(existsSync(started), false);
      writeFileSync(childPath, '{"roster":{"enabled":false}}');
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true,
        roles: [{ ...selectedRole, effort: "low" }] } }));
      const changed = await load();
      await assert.rejects(
        launch(changed.tools, { resume_session_id: sessionId }), /effort/i,
      );
      assert.equal(existsSync(started), false);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "resources") {
      writeFileSync(join(root, "role/skill.md"), "# Skill");
      writeFileSync(join(root, "role/extra.ts"), "export default function () {}");
      writeFileSync(join(root, "role/child.json"), '{"roster":{"enabled":false}}');
      const resources = { skills: ["./skill.md"], extensions: ["./extra.ts"],
        mcp_servers: [], inherit_personal_resources: false, inherit_project_resources: false };
      writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true, roles: [
        { ...role, resources, roster_file: "child.json" },
      ] } }));
      const { tools } = await load();
      // Act
      const child = report(await launch(tools, { roster_entry: "owner" }));
      // Assert
      assert.ok(child.args.includes("--no-skills"));
      assert.ok(child.args.includes("--no-extensions"));
      assert.ok(child.args.includes("--no-mcp"));
      assert.ok(child.args.includes(join(root, "role/skill.md")));
      assert.ok(child.args.includes(join(root, "role/extra.ts")));
      rmSync(started);
      for (const params of [
        { roster_entry: "owner", resources: {} },
        { roster_entry: "owner", roster_file: rosterPath },
        { agent_type: "pi", resources: { extensions: ["missing.ts"] } },
        { agent_type: "pi", resources: { packages: ["npm:never-install@1.0.0"] } },
        { agent_type: "pi", resources: { mcp_servers: [{ name: "unsupported" }] } },
        { agent_type: "pi", roster_file: join(root, "missing.json") },
      ]) {
        await assert.rejects(launch(tools, params), /conflict|path|supports only|configuration/i);
        assert.equal(existsSync(started), false);
      }
      writeFileSync(join(root, "role/child.json"), "{");
      await assert.rejects(launch(tools, { roster_entry: "owner" }), /valid JSON/);
      assert.equal(existsSync(started), false);
      const adHoc = report(await launch(tools, { agent_type: "pi", cwd: join(root, "role"),
        resources }));
      assert.ok(adHoc.args.includes(join(root, "role/skill.md")));
      assert.equal(adHoc.roster, null);
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    const { tools } = await load();
    const tool = tools.get("subagent")!;
    const properties = tool.parameters.properties;
    assert.match(properties.resources.description, /local.*paths.*cwd/i);
    assert.match(properties.resume_session_id.description, /known selected.*omit/i);
    assert.match(tool.description, /do not resume.*active/i);

    // Act: the caller only supplies the role name and the task.
    const result = await launch(tools, { roster_entry: "owner" });
    const child = report(result);

    // Assert: effective role settings reached the real worker and native CLI boundary.
    assert.equal(child.cwd, join(root, "role/work"));
    assert.ok(child.args.includes("test-model"));
    assert.ok(child.args.includes("high"));
    assert.equal(child.home, root);
    assert.equal(child.depth, "1");
    assert.equal(child.maxDepth, "2");
    rmSync(started);
    for (const params of [
      { roster_entry: "unknown" },
      { roster_entry: "owner", model: "different" },
      { roster_entry: "owner", agent_type: "codex" },
      { roster_entry: "owner", effort: "low" },
      { roster_entry: "owner", cwd: root },
    ]) {
      await assert.rejects(launch(tools, params), /Unknown roster entry|conflict/i);
      assert.equal(existsSync(started), false);
    }
    assert.equal(readFileSync(globalPath, "utf8"), '{"max_sub_agent_depth":2}');
    process.stderr.write("ROSTER_LAUNCH_OK\n");
  } finally {
    await closeAgentShellWorkers();
    for (const key of [
      "PATH", "PI_AGENTSHELL_ROSTER_FILE", "ROSTER_STARTED", "ROSTER_SESSION_ID",
      "PI_AGENT_SHELL_CHILD",
      "PI_AGENT_SHELL_DEPTH", "PI_AGENT_SHELL_MAX_DEPTH"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}
