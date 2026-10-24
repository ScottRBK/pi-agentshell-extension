import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
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

async function checkValidationOrder(): Promise<void> {
  // Arrange: several invalid settings compete; only the first failure is observable.
  const { tools, messages } = await load();
  const missing = join(root, "missing.json");
  const cases: Array<[object, RegExp]> = [
    [{ resume_session_id: "job-invalid", roster_entry: "unknown" }, /native Session ID/],
    [{ resume_session_id: "unrecorded", roster_entry: "unknown" }, /No recorded launch/],
    [{ agent_type: "codex", roster_entry: "unknown", roster_file: missing },
      /Unknown roster entry/],
    [{ agent_type: "codex", roster_file: missing, resources: { skills: [missing] } },
      /roster_file is supported only/],
    [{ roster_entry: "owner", model: "conflict", resources: { skills: [missing] } },
      /Manual model conflicts/],
    [{ agent_type: "pi", resources: { skills: [missing] }, roster_file: missing },
      /resources.skills/],
    [{ roster_file: missing }, /roster_file is supported only/],
    [{ agent_type: "pi", roster_file: missing }, /Invalid AgentShell configuration/],
  ];
  // Act / Assert: both direct and queued modes reject without a worker or follow-up.
  for (const mode of ["json", "rpc"] as const) {
    for (const [params, expected] of cases) {
      await assert.rejects(launch(tools, params, mode), expected);
      assert.equal(existsSync(started), false);
      assert.equal(messages.length, 0);
    }
  }
}

async function checkAmbiguousResume(): Promise<void> {
  // Arrange: native IDs belong to a harness, not to the background job registry.
  const fakeCodex = join(root, "bin/codex");
  copyFileSync(fileURLToPath(new URL("roster-codex.py", import.meta.url)), fakeCodex);
  chmodSync(fakeCodex, 0o755);
  const initial = await load();
  const first = await launch(initial.tools, { roster_entry: "owner" });
  const details = first.details;
  assert.ok(typeof details === "object" && details !== null);
  assert.ok("sessionId" in details && typeof details.sessionId === "string");
  const sessionId = details.sessionId;
  process.env.ROSTER_SESSION_ID = sessionId;
  await launch(initial.tools, { agent_type: "codex", model: "codex-model" });
  const { tools, messages } = await load();
  rmSync(started);
  // Act / Assert: ambiguity takes precedence over later selection validation.
  for (const agent_type of [undefined, "unsupported"]) {
    await assert.rejects(launch(tools, { agent_type, resume_session_id: sessionId,
      roster_entry: "unknown" }), /Ambiguous native session ID; specify the original agent_type/);
    assert.equal(existsSync(started), false);
    assert.equal(messages.length, 0);
  }
  const pi = report(await launch(tools, { agent_type: "pi", resume_session_id: sessionId }));
  const codex = report(await launch(tools, { agent_type: "codex", resume_session_id: sessionId }));
  assert.ok(pi.args.includes("test-model"));
  assert.equal(pi.cwd, join(root, "role/work"));
  assert.ok(codex.args.includes("codex-model"));
  assert.ok(codex.args.includes(sessionId));
}

function configureAgentFiles() {
  const parent = join(root, "parent/agent.json");
  const child = join(root, "child/agent.json");
  mkdirSync(join(root, "parent"));
  mkdirSync(join(root, "child"));
  mkdirSync(join(root, "worktree"));
  writeFileSync(join(root, "child/skill.md"), "# Selected skill");
  const agent = { name: "night-owl", description: "A freely named agent", agent_type: "pi",
    model: "child-model", effort: "low", resources: { skills: ["./skill.md"] } };
  const document = { agent, roster: { enabled: false, roles: [] as object[] } };
  writeFileSync(child, JSON.stringify(document));
  const parentDocument = { agent: { name: "coordinator", description: "Coordinate",
    agent_type: "pi", model: "parent-model", effort: "high" },
    roster: { enabled: true, roles: [{ agent_file: "../child/agent.json" }] } };
  writeFileSync(parent, JSON.stringify(parentDocument));
  process.env.PI_AGENTSHELL_ROSTER_FILE = parent;
  return { parent, child, document, parentDocument };
}

function configurePromptSkills(agentType = "codex") {
  const files = configureAgentFiles();
  const name = agentType === "codex" ? "codex" : "claude";
  const fake = join(root, `bin/${name}`);
  copyFileSync(fileURLToPath(new URL(`roster-${name}.py`, import.meta.url)), fake);
  chmodSync(fake, 0o755);
  for (const file of ["role.md", "tdd.md", "extra.md"]) {
    writeFileSync(join(root, "child", file), "PRIVATE_SKILL_BODY_MUST_NOT_BE_EMBEDDED");
  }
  const document = { ...files.document, agent: { ...files.document.agent, agent_type: agentType,
    resources: { skills: ["./role.md", "./tdd.md", "./extra.md"] } } };
  writeFileSync(files.child, JSON.stringify(document));
  return { ...files, document };
}

async function checkCodexPromptSkills(): Promise<void> {
  // Arrange: the full caller briefing deliberately contains no selected skill references.
  const { parent, child } = configurePromptSkills();
  const originals = [parent, child, globalPath].map((path) => readFileSync(path, "utf8"));
  const environment = { ...process.env };
  const briefing = "Full role briefing.\nImplement ticket 42 in the worktree.\n"
    + "Keep review gates.\n";
  const { tools } = await load();
  const list = () => tools.get("subagent_roster")!.execute("list", {}, undefined,
    undefined, context);
  const before = await list();
  // Act: the real worker/SDK prepares a fake native Codex invocation.
  const result = report(await launch(tools, { roster_entry: "night-owl", prompt: briefing,
    cwd: "./worktree" }));
  // Assert: exact briefing plus read directive and all three selected absolute file paths.
  assert.equal(result.args.at(-1), briefing + "\n\n"
    + "Selected skill files: read and follow these before doing the assigned task.\n"
    + `- "${root}/child/extra.md"\n- "${root}/child/role.md"\n- "${root}/child/tdd.md"`);
  assert.ok(!result.args.includes("--skill"));
  assert.deepEqual(await list(), before);
  assert.deepEqual(JSON.parse(before.content[0].text)[0].resources.skills,
    [join(root, "child/role.md"), join(root, "child/tdd.md"), join(root, "child/extra.md")]);
  assert.deepEqual([parent, child, globalPath].map((path) => readFileSync(path, "utf8")),
    originals);
  assert.deepEqual({ ...process.env }, environment);
}

async function checkClaudePromptSkills(): Promise<void> {
  // Arrange: Claude has the same selected files; no MCP configuration is required.
  configurePromptSkills("claude_code");
  const briefing = "Claude full briefing.\nTask, worktree, review and permission requirements.";
  const { tools, messages } = await load();
  const expected = briefing + "\n\n"
    + "Selected skill files: read and follow these before doing the assigned task.\n"
    + `- "${root}/child/extra.md"\n- "${root}/child/role.md"\n- "${root}/child/tdd.md"`;
  // Act / Assert: both foreground and background deliver the same exact prompt and controls.
  for (const mode of ["json", "rpc"] as const) {
    const launchResult = await launch(tools, { roster_entry: "night-owl", prompt: briefing,
      cwd: "./worktree", auto_approve: false, allowed_tools: ["Read"],
      disallowed_tools: ["bash"] }, mode);
    let native;
    if (mode === "json") native = report(launchResult);
    else {
      const end = Date.now() + 5_000;
      while (!messages.length && Date.now() < end) await delay(10);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].details.status, "completed");
      const output = messages[0].content.slice(messages[0].content.indexOf("\n\n") + 2);
      native = report({ content: [{ text: output }] });
    }
    assert.equal(native.args[native.args.indexOf("-p") + 1], expected);
    assert.equal(native.cwd, join(root, "worktree"));
    assert.equal(native.mcp, null);
    assert.equal(native.args[native.args.indexOf("--allowed-tools") + 1], "Read");
    assert.equal(native.args[native.args.indexOf("--disallowed-tools") + 1], "Bash");
    assert.ok(!native.args.includes("--dangerously-skip-permissions"));
    assert.ok(!native.args.includes("--skill"));
  }
}

async function checkPromptSkillDirectories(): Promise<void> {
  // Arrange: collection roots, overlapping selections and lexical links to shared files.
  const { child, document } = configurePromptSkills();
  for (const dir of ["role-root", "catalog/a", "catalog/a/nested", "catalog/z/deep",
    "catalog/.hidden", "catalog/node_modules", "storage"]) {
    mkdirSync(join(root, "child", dir), { recursive: true });
  }
  for (const dir of ["role-root", "catalog/a", "catalog/a/nested", "catalog/z/deep"]) {
    writeFileSync(join(root, "child", dir, "SKILL.md"), "DO_NOT_EMBED_BODY");
  }
  writeFileSync(join(root, 'child/quoted "skill".txt'), "EXPLICIT_FILE_BODY");
  writeFileSync(join(root, "child/catalog/unrelated.md"), "NOT_A_SKILL_ROOT");
  symlinkSync(join(root, "child/catalog"), join(root, "child/catalog/.hidden/loop"));
  symlinkSync(join(root, "child/catalog"), join(root, "child/catalog/node_modules/loop"));
  symlinkSync(join(root, "child/catalog"), join(root, "child/alias"));
  const selected = { ...document, agent: { ...document.agent, resources: { skills: [
    "./role-root", "./catalog", "./alias/a", './quoted "skill".txt',
    "./catalog/a/SKILL.md", "./role-root/SKILL.md",
  ] } } };
  writeFileSync(join(root, "child/storage/agent.json"), JSON.stringify(selected));
  rmSync(child);
  symlinkSync(join(root, "child/storage/agent.json"), child);
  // Act / Assert: root discovery stops at SKILL.md; exact lexical paths remain distinct.
  const { tools } = await load();
  const native = report(await launch(tools, { roster_entry: "night-owl", prompt: "Briefing" }));
  assert.equal(native.args.at(-1), "Briefing\n\n"
    + "Selected skill files: read and follow these before doing the assigned task.\n"
    + `- "${root}/child/alias/a/SKILL.md"\n- "${root}/child/catalog/a/SKILL.md"\n`
    + `- "${root}/child/catalog/z/deep/SKILL.md"\n`
    + `- "${root}/child/quoted \\"skill\\".txt"\n- "${root}/child/role-root/SKILL.md"`);
}

async function checkPromptSkillFailures(): Promise<void> {
  // Arrange: failures are local filesystem conditions, not mocked discovery errors.
  const { child, document } = configurePromptSkills();
  for (const dir of ["empty", "cycle", "bad-root/SKILL.md", "unreadable-dir",
    "collection/blocked", "dangling"]) mkdirSync(join(root, "child", dir), { recursive: true });
  symlinkSync(join(root, "child/cycle"), join(root, "child/cycle/back"));
  symlinkSync(join(root, "missing"), join(root, "child/dangling/link"));
  writeFileSync(join(root, "child/unreadable.md"), "UNREADABLE");
  const cases: Array<[string, RegExp, string?]> = [
    ["empty", /No skill files/], ["cycle", /cycle/i],
    ["bad-root", /regular skill file/], ["dangling", /ENOENT/],
    ["unreadable.md", /EACCES/, "unreadable.md"],
    ["unreadable-dir", /EACCES/, "unreadable-dir"],
    ["collection", /EACCES/, "collection/blocked"],
  ];
  for (const [path, error, blocked] of cases) {
    writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
      resources: { skills: [`./${path}`] } } }));
    const { tools, messages } = await load();
    if (blocked) chmodSync(join(root, "child", blocked), 0);
    try {
      // Act / Assert: foreground and queued calls reject before any native process or job.
      for (const mode of ["json", "rpc"] as const) {
        await assert.rejects(launch(tools, { roster_entry: "night-owl" }, mode),
          (failure: Error) => {
            assert.match(failure.message, error);
            assert.ok(failure.message.includes(join(root, "child", path)));
            return true;
          });
        assert.equal(existsSync(started), false);
        assert.equal(messages.length, 0);
      }
    } finally {
      if (blocked) chmodSync(join(root, "child", blocked), 0o700);
    }
  }
  // Existing strict selection validation also rejects disappeared/nonregular explicit paths.
  const gone = join(root, "child/gone.md");
  writeFileSync(gone, "present at load");
  writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
    resources: { skills: [gone] } } }));
  const { tools } = await load();
  rmSync(gone);
  await assert.rejects(launch(tools, { roster_entry: "night-owl" }),
    /Invalid resources.skills path/);
  assert.equal(spawnSync("/usr/bin/mkfifo", [gone]).status, 0);
  await assert.rejects(load(), /Invalid resources.skills path/);
  assert.equal(existsSync(started), false);
}

async function checkPromptSkillNativeOptions(): Promise<void> {
  // Arrange: skills accompany supported and unsupported native resource/control selections.
  const { child, document } = configurePromptSkills();
  const claude = join(root, "bin/claude");
  copyFileSync(fileURLToPath(new URL("roster-claude.py", import.meta.url)), claude);
  chmodSync(claude, 0o755);
  mkdirSync(join(root, "child/plugin"));
  writeFileSync(join(root, "child/extra.ts"), "// Native extension");
  for (const agent_type of ["codex", "claude_code"]) {
    const unsupported = [
      { extensions: ["./extra.ts"] }, { inherit_personal_resources: false },
      { inherit_project_resources: false }, { include_instruction_files: false },
      { include_home_system_prompt: false },
      ...(agent_type === "codex" ? [{ plugins: ["./plugin"] }, { mcp_servers: [] }] : []),
    ];
    for (const option of unsupported) {
      writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent, agent_type,
        resources: { ...document.agent.resources, ...option } } }));
      const { tools, messages } = await load();
      rmSync(started, { force: true });
      // Act / Assert: clearing only skills must not hide any other native error.
      await assert.rejects(launch(tools, { roster_entry: "night-owl" }),
        new RegExp(`session resources do not support: ${Object.keys(option)[0]}`));
      assert.equal(existsSync(started), false);
      if ("extensions" in option) {
        await launch(tools, { roster_entry: "night-owl" }, "rpc");
        const end = Date.now() + 5_000;
        while (!messages.length && Date.now() < end) await delay(10);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].details.status, "failed");
        assert.match(messages[0].content, /session resources do not support: extensions/);
        assert.equal(existsSync(started), false);
      }
    }
  }
  writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
    agent_type: "claude_code", resources: { ...document.agent.resources,
      plugins: ["./plugin"], mcp_servers: [] } } }));
  const native = report(await launch((await load()).tools, { roster_entry: "night-owl",
    auto_approve: true, allowed_tools: ["Read"], disallowed_tools: ["bash"], cwd: "worktree" }));
  assert.equal(native.args[native.args.indexOf("--plugin-dir") + 1], join(root, "child/plugin"));
  assert.ok(native.args.includes("--strict-mcp-config"));
  assert.deepEqual(native.mcp, { mcpServers: {} });
  assert.equal(native.cwd, join(root, "worktree"));
  assert.ok(native.args.includes("--dangerously-skip-permissions"));
  assert.equal(native.args[native.args.indexOf("--allowed-tools") + 1], "Read");
  assert.equal(native.args[native.args.indexOf("--disallowed-tools") + 1], "Bash");
  writeFileSync(child, JSON.stringify(document));
  const codex = report(await launch((await load()).tools, { roster_entry: "night-owl",
    auto_approve: true, disallowed_tools: ["web_search"], cwd: "worktree" }));
  assert.ok(codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(codex.args.includes('web_search="disabled"'));
  assert.equal(codex.cwd, join(root, "worktree"));
  assert.equal(codex.roster, null);
  // No skills means no block, including an explicit all-default resource selection.
  for (const resources of [{ skills: [] }, {}]) {
    writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent, resources } }));
    const plain = report(await launch((await load()).tools,
      { roster_entry: "night-owl", prompt: "Unchanged prompt\n" }));
    assert.equal(plain.args.at(-1), "Unchanged prompt\n");
  }
}

async function checkPromptSkillResume(agentType: string): Promise<void> {
  // Arrange: retain the full canonical skill selection through a real completed native turn.
  const { parent, child, document, parentDocument } = configurePromptSkills(agentType);
  const initial = await load();
  const first = await launch(initial.tools, { roster_entry: "night-owl", prompt: "First briefing",
    auto_approve: true, cwd: "worktree" });
  const resume = { resume_session_id: first.details.sessionId };
  const branch = [...history];
  const promptOf = (result: any) => {
    const native = report(result);
    return agentType === "codex" ? native.args.at(-1) : native.args[native.args.indexOf("-p") + 1];
  };
  const expected = "New full briefing\n\n"
    + "Selected skill files: read and follow these before doing the assigned task.\n"
    + `- "${root}/child/extra.md"\n- "${root}/child/role.md"\n- "${root}/child/tdd.md"`;
  // Act / Assert: a reload and branch restore keep original resources, not stripped native ones.
  history.length = 0;
  const restored = await load();
  await assert.rejects(launch(restored.tools, { ...resume, roster_entry: "night-owl" }),
    /No recorded launch/);
  history.push(...branch);
  await restored.handlers.get("session_tree")!({ type: "session_tree" }, context);
  const continued = await launch(restored.tools, { ...resume, prompt: "New full briefing" });
  assert.equal(promptOf(continued), expected);
  assert.equal(report(continued).cwd, join(root, "worktree"));
  assert.ok(report(continued).args.includes(first.details.sessionId));
  assert.ok(!report(continued).args.includes(agentType === "codex"
    ? "--dangerously-bypass-approvals-and-sandbox" : "--dangerously-skip-permissions"));
  rmSync(started);
  await assert.rejects(launch(restored.tools, { ...resume, resources: { skills: [] } }),
    /Manual resources conflicts/);
  assert.equal(existsSync(started), false);
  const changed = { ...document, agent: { ...document.agent,
    resources: { skills: ["./role.md"] } } };
  writeFileSync(child, JSON.stringify(changed));
  for (const params of [{ roster_entry: "night-owl" }, resume]) {
    await assert.rejects(launch(restored.tools, params), /Agent definition changed.*resources/);
    assert.equal(existsSync(started), false);
  }
  const reloaded = await load();
  await assert.rejects(launch(reloaded.tools, resume), /Original roster_entry changed.*resources/);
  assert.equal(existsSync(started), false);
  const fresh = await launch(reloaded.tools, { roster_entry: "night-owl", prompt: "Fresh" });
  assert.equal(promptOf(fresh),
    "Fresh\n\nSelected skill files: read and follow these before doing the assigned task.\n"
      + `- "${root}/child/role.md"`);
  writeFileSync(child, JSON.stringify(document));
  const otherParent = join(root, "parent/other.json");
  writeFileSync(otherParent, JSON.stringify(parentDocument));
  process.env.PI_AGENTSHELL_ROSTER_FILE = otherParent;
  rmSync(started);
  await assert.rejects(launch((await load()).tools, resume), /roster source/);
  process.env.PI_AGENTSHELL_ROSTER_FILE = parent;
  const otherChild = join(root, "child/other.json");
  writeFileSync(otherChild, JSON.stringify(document));
  writeFileSync(parent, JSON.stringify({ ...parentDocument, roster: { enabled: true,
    roles: [{ agent_file: "../child/other.json" }] } }));
  await assert.rejects(launch((await load()).tools, resume), /changed.*agent_file/);
  assert.equal(existsSync(started), false);
}

async function checkPromptSkillMembership(): Promise<void> {
  // Arrange: a directory path is canonical; its membership is intentionally not snapshotted.
  const { child, document } = configurePromptSkills();
  mkdirSync(join(root, "child/collection/a"), { recursive: true });
  writeFileSync(join(root, "child/collection/a/SKILL.md"), "INITIAL_BODY");
  writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
    resources: { skills: ["./collection"] } } }));
  const { tools, messages } = await load();
  const first = await launch(tools, { roster_entry: "night-owl" });
  assert.ok(report(first).args.at(-1).endsWith(`- "${root}/child/collection/a/SKILL.md"`));
  mkdirSync(join(root, "child/collection/b"));
  writeFileSync(join(root, "child/collection/b/SKILL.md"), "NEW_BODY");
  writeFileSync(join(root, "child/collection/a/SKILL.md"), "CHANGED_BODY");
  // Act: unchanged saved selection expands current membership during a background resume.
  await launch(tools, { resume_session_id: first.details.sessionId,
    prompt: "Resume briefing" }, "rpc");
  const end = Date.now() + 5_000;
  while (!messages.length && Date.now() < end) await delay(10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].details.status, "completed");
  const output = messages[0].content.slice(messages[0].content.indexOf("\n\n") + 2);
  const native = report({ content: [{ text: output }] });
  assert.equal(native.args.at(-1), "Resume briefing\n\n"
    + "Selected skill files: read and follow these before doing the assigned task.\n"
    + `- "${root}/child/collection/a/SKILL.md"\n- "${root}/child/collection/b/SKILL.md"`);
  rmSync(join(root, "child/collection/a"), { recursive: true });
  const next = report(await launch(tools, { resume_session_id: first.details.sessionId }));
  assert.ok(next.args.at(-1).endsWith(`- "${root}/child/collection/b/SKILL.md"`));
  assert.ok(!next.args.at(-1).includes("/collection/a/"));
  rmSync(join(root, "child/collection/b"), { recursive: true });
  rmSync(started);
  await assert.rejects(launch(tools, { resume_session_id: first.details.sessionId }),
    /No skill files/);
  assert.equal(existsSync(started), false);
}

async function checkPromptSkillScope(): Promise<void> {
  // Arrange: only selected normalized Codex/Claude definitions use prompt references.
  const { parent, child, document } = configurePromptSkills();
  const resources = { skills: [join(root, "child/role.md")] };
  for (const agent_type of ["codex", "claude_code"]) {
    process.env.PI_AGENTSHELL_ROSTER_FILE = parent;
    const { tools } = await load();
    await assert.rejects(launch(tools, { agent_type, resources }),
      /session resources do not support: skills/);
    writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true,
      roles: [{ ...document.agent, agent_type, resources }] } }));
    process.env.PI_AGENTSHELL_ROSTER_FILE = rosterPath;
    await assert.rejects(launch((await load()).tools, { roster_entry: "night-owl" }),
      /session resources do not support: skills/);
    assert.equal(existsSync(started), false);
  }
  process.env.PI_AGENTSHELL_ROSTER_FILE = parent;
  writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
    agent_type: "grok" } }));
  await assert.rejects(launch((await load()).tools, { roster_entry: "night-owl" }),
    /Grok session resources do not support: skills/);
  assert.equal(existsSync(started), false);
  // Act / Assert: Pi still uses native skill flags and receives the caller's prompt unchanged.
  writeFileSync(child, JSON.stringify({ ...document,
    agent: { ...document.agent, agent_type: "pi" } }));
  const pi = report(await launch((await load()).tools,
    { roster_entry: "night-owl", prompt: "Native Pi briefing" }));
  assert.equal(pi.args.at(-1), "Native Pi briefing");
  assert.ok(pi.args.includes("--skill"));
  assert.ok(pi.args.includes(join(root, "child/role.md")));
  // OpenCode supports native skills; do not classify it with Codex/Claude.
  const executable = join(root, "bin/opencode");
  copyFileSync(fileURLToPath(new URL("roster-opencode.py", import.meta.url)), executable);
  chmodSync(executable, 0o755);
  delete process.env.OPENCODE_CONFIG_CONTENT;
  writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
    agent_type: "opencode" } }));
  const opencode = report(await launch((await load()).tools,
    { roster_entry: "night-owl", prompt: "Native OpenCode briefing" }));
  assert.equal(opencode.args.at(-1), "Native OpenCode briefing");
  assert.deepEqual(opencode.config.skills.paths, [join(root, "child/role.md"),
    join(root, "child/tdd.md"), join(root, "child/extra.md")]);
}

async function checkInteractivePromptSkills(): Promise<void> {
  // Arrange: private tmux, real SDK, and an independent observer of each original native handle.
  const { parent, child, document } = configureAgentFiles();
  const fixture = fileURLToPath(new URL("roster-agent.py", import.meta.url));
  writeFileSync(join(root, "bin/tmux"),
    `#!/bin/sh\nexec '${process.env.ROSTER_TMUX}' -f /dev/null `
      + `-S '${process.env.ROSTER_SOCKET}' "$@"\n`, { mode: 0o755 });
  const panes = () => {
    const result = spawnSync(process.env.ROSTER_TMUX!, ["-S", process.env.ROSTER_SOCKET!,
      "list-panes", "-t", "roster-test:0", "-F", "#{pane_id}"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n");
  };
  const originalPanes = panes();
  assert.equal(originalPanes.length, 1);
  for (const agent_type of ["codex", "claude_code"]) {
    const executable = join(root, "bin", agent_type === "codex" ? "codex" : "claude");
    copyFileSync(fixture, executable);
    chmodSync(executable, 0o755);
    writeFileSync(child, JSON.stringify({ ...document,
      agent: { ...document.agent, agent_type } }));
    const originals = [parent, child, globalPath].map((path) => readFileSync(path, "utf8"));
    const socket = join(root, `${agent_type}.sock`);
    const observed = join(root, `${agent_type}.json`);
    const observer = spawn("/usr/bin/python3", [fixture, "--observe-native", socket, observed],
      { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    observer.stderr.on("data", (chunk) => { errors += chunk; });
    const observerExit = new Promise<number | null>((resolve, reject) => {
      observer.once("error", reject);
      observer.once("close", resolve);
    });
    const { tools, handlers } = await load();
    try {
      const readyBy = Date.now() + 3_000;
      while (!existsSync(socket) && Date.now() < readyBy) await delay(10);
      assert.ok(existsSync(socket), "observer did not bind its private socket");
      process.env.ROSTER_INTERACTIVE_SOCKET = socket;
      const list = () => tools.get("subagent_roster")!.execute("list", {}, undefined,
        undefined, context);
      const canonical = await list();
      const briefing = "Full interactive role briefing.\n"
        + "Task, review and permission requirements.\n";
      // Act: no auto_approve or tool restrictions; native interactive permissions remain enabled.
      const result = await launch(tools, { roster_entry: "night-owl", prompt: briefing,
        cwd: "worktree", interactive: true, stay_open: true, inactivity_timeout: 1 });
      // Assert: read the exact argv supplied to the fake native CLI, captured while it was live.
      const native = JSON.parse(readFileSync(observed, "utf8"));
      assert.equal(native.alive_at_capture, true);
      assert.equal(native.exited, false);
      assert.equal(native.args[native.args.indexOf("--") + 1], briefing + "\n\n"
        + "Selected skill files: read and follow these before doing the assigned task.\n"
        + `- "${root}/child/skill.md"`);
      assert.equal(native.cwd, join(root, "worktree"));
      assert.equal(native.roster, null);
      assert.equal(native.args[native.args.indexOf("--model") + 1], "child-model");
      assert.ok(agent_type === "codex" ? native.args.includes('model_reasoning_effort="low"')
        : native.args[native.args.indexOf("--effort") + 1] === "low");
      for (const flag of ["--skill", "--dangerously-skip-permissions",
        "--dangerously-bypass-approvals-and-sandbox", "--allowed-tools", "--disallowed-tools"]) {
        assert.ok(!native.args.includes(flag));
      }
      assert.match(result.content[0].text, /OFFLINE_SKILL_DELIVERY/);
      assert.equal(result.details.sessionId, undefined);
      assert.deepEqual(await list(), canonical);
      assert.deepEqual(JSON.parse(canonical.content[0].text)[0].resources.skills,
        [join(root, "child/skill.md")]);
      assert.deepEqual([parent, child, globalPath].map((path) => readFileSync(path, "utf8")),
        originals);
      assert.equal(panes().length, 2);
    } finally {
      await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context);
      observer.stdin.end();
      assert.equal(await observerExit, 0, errors);
      delete process.env.ROSTER_INTERACTIVE_SOCKET;
    }
    assert.equal(JSON.parse(readFileSync(observed, "utf8")).exited, true);
    assert.deepEqual(panes(), originalPanes);
    process.stderr.write(`INTERACTIVE_SKILLS_${agent_type}_EXIT_OK\n`);
  }
}

async function checkInlineDiagnostic(): Promise<void> {
  // Arrange: an existing native inline role has a missing working directory.
  writeFileSync(rosterPath, JSON.stringify({ roster: { enabled: true,
    roles: [{ ...role, cwd: "./missing" }] } }));
  // Act / Assert: loading the public extension preserves the original exact error text.
  await assert.rejects(load(), { message:
    `Invalid AgentShell configuration at ${rosterPath}: roster.roles[0] ("owner"): `
    + `Invalid cwd path: ${join(root, "role/missing")}` });
  assert.equal(existsSync(started), false);
}

async function checkNestedDiagnostic(): Promise<void> {
  // Arrange: the child's own reference is missing; strict path validation still applies.
  const { parent, child, document } = configureAgentFiles();
  writeFileSync(child, JSON.stringify({ ...document, roster: { enabled: true,
    roles: [{ agent_file: "./missing.json" }] } }));
  // Act / Assert: both containing files are identified, without nested Error prefixes.
  await assert.rejects(load(), { message:
    `Invalid AgentShell configuration at ${parent}: roster.roles[0]: `
    + `Invalid AgentShell configuration at ${child}: roster.roles[0]: `
    + `Invalid agent_file path: ${join(root, "child/missing.json")}` });
  assert.equal(existsSync(started), false);
}

async function checkAgentFileSymlinks(): Promise<void> {
  // Arrange: selected and child links live apart from their stored document targets.
  const { parent, child, document, parentDocument } = configureAgentFiles();
  mkdirSync(join(root, "storage/deep"), { recursive: true });
  mkdirSync(join(root, "child/work"));
  writeFileSync(join(root, "storage/deep/root.json"), JSON.stringify(parentDocument));
  writeFileSync(join(root, "storage/deep/child.json"), JSON.stringify({ ...document,
    agent: { ...document.agent, cwd: "./work" } }));
  rmSync(parent);
  rmSync(child);
  symlinkSync(join(root, "storage/deep/root.json"), parent);
  symlinkSync(join(root, "storage/deep/child.json"), child);
  // Act: load, discover and launch using the lexical paths of both links.
  const { tools } = await load();
  const listing = await tools.get("subagent_roster")!.execute("list", {}, undefined,
    undefined, context);
  // Assert: resources, cwd and the child's selector use the child link's directory.
  assert.deepEqual(JSON.parse(listing.content[0].text), [{
    name: "night-owl", description: "A freely named agent", agent_type: "pi",
    model: "child-model", effort: "low", cwd: join(root, "child/work"),
    resources: { skills: [join(root, "child/skill.md")], plugins: [], extensions: [],
      packages: [], mcp_servers: null, inherit_personal_resources: true,
      inherit_project_resources: true, include_instruction_files: true,
      include_home_system_prompt: true },
    agent_file: join(root, "child/agent.json"), roster_file: join(root, "child/agent.json"),
  }]);
  const result = report(await launch(tools, { roster_entry: "night-owl" }));
  assert.equal(result.cwd, join(root, "child/work"));
  assert.equal(result.roster, join(root, "child/agent.json"));
  assert.ok(result.args.includes(join(root, "child/skill.md")));
  assert.ok(result.args.includes("child-model"));
  assert.equal(process.env.PI_AGENTSHELL_ROSTER_FILE, join(root, "parent/agent.json"));
}

async function checkDistinctDuplicateNames(): Promise<void> {
  // Arrange: separate files declare the same identity but different model settings.
  const { parent, document, parentDocument } = configureAgentFiles();
  writeFileSync(join(root, "child/other.json"), JSON.stringify({ ...document,
    agent: { ...document.agent, model: "other-model" } }));
  writeFileSync(parent, JSON.stringify({ ...parentDocument, roster: { enabled: true,
    roles: [{ agent_file: "../child/agent.json" }, { agent_file: "../child/other.json" }] } }));
  // Act / Assert: identity is the declared name, not the file's path.
  await assert.rejects(load(), { message:
    `Invalid AgentShell configuration at ${parent}: duplicate roster role name "night-owl"` });
  assert.equal(existsSync(started), false);
}

async function checkNativeReferenceRejection(): Promise<void> {
  // Arrange: the reference exists, so native-format rejection cannot be a missing-path error.
  const { child } = configureAgentFiles();
  for (const path of [rosterPath, globalPath]) {
    if (path === rosterPath) process.env.PI_AGENTSHELL_ROSTER_FILE = rosterPath;
    else delete process.env.PI_AGENTSHELL_ROSTER_FILE;
    for (const entry of [{ ...role, agent_file: child }, { agent_file: child }]) {
      writeFileSync(path, JSON.stringify({ roster: { enabled: true, roles: [entry] } }));
      // Act / Assert: neither selected inline nor personal global roles accept references.
      await assert.rejects(load(), { message:
        `Invalid AgentShell configuration at ${path}: `
        + 'unknown roster.roles[0] setting "agent_file"' });
      assert.equal(existsSync(started), false);
    }
  }
}

async function checkAgentFiles(): Promise<void> {
  // Arrange: parent, child and caller worktree are deliberately different directories.
  const { parent, child } = configureAgentFiles();
  const globalText = readFileSync(globalPath, "utf8");
  const environment = { ...process.env };
  const { tools } = await load();
  // Act: discover the child's own name, then launch it through the public tool.
  const listing = await tools.get("subagent_roster")!.execute("list", {}, undefined,
    undefined, context);
  const entries = JSON.parse(listing.content[0].text);
  assert.equal(entries[0].name, "night-owl");
  assert.equal(entries[0].description, "A freely named agent");
  assert.equal(entries[0].model, "child-model");
  assert.equal(entries[0].effort, "low");
  assert.equal(entries[0].agent_file, child);
  assert.deepEqual(entries[0].resources.skills, [join(root, "child/skill.md")]);
  const result = report(await launch(tools, { roster_entry: "night-owl", cwd: "./worktree" }));
  // Assert: caller cwd survives omission in the file; resources use the child's base.
  assert.equal(result.cwd, join(root, "worktree"));
  assert.equal(result.roster, child);
  assert.ok(result.args.includes("child-model"));
  assert.ok(result.args.includes("low"));
  assert.ok(result.args.includes(join(root, "child/skill.md")));
  assert.ok(!result.args.includes("parent-model"));
  assert.equal(report(await launch(tools, { roster_entry: "night-owl" })).cwd, root);
  assert.equal(process.env.PI_AGENTSHELL_ROSTER_FILE, parent);
  assert.deepEqual({ ...process.env }, environment);
  assert.equal(readFileSync(globalPath, "utf8"), globalText);
}

async function checkAgentFileNonPi(): Promise<void> {
  // Arrange: an independently named Codex leaf shares the native launch path.
  const { parent, child, document, parentDocument } = configureAgentFiles();
  const fakeCodex = join(root, "bin/codex");
  copyFileSync(fileURLToPath(new URL("roster-codex.py", import.meta.url)), fakeCodex);
  chmodSync(fakeCodex, 0o755);
  const leaf = { ...document, agent: { ...document.agent, name: "cedar",
    agent_type: "codex", resources: {} } };
  writeFileSync(child, JSON.stringify(leaf));
  const { tools } = await load();
  // Act / Assert: no Pi selector reaches the non-Pi native process.
  const first = await launch(tools, { roster_entry: "cedar" });
  assert.equal(report(first).roster, null);
  assert.ok(report(first).args.includes("child-model"));
  const resume = { resume_session_id: first.details.sessionId };
  assert.equal(report(await launch((await load()).tools, resume)).roster, null);
  writeFileSync(child, JSON.stringify({ ...leaf, agent: { ...leaf.agent, effort: "high" } }));
  await assert.rejects(launch(tools, resume), /Agent definition changed.*effort/);
  await assert.rejects(launch((await load()).tools, resume),
    /Original roster_entry changed.*effort/);
  writeFileSync(child, JSON.stringify(leaf));
  const alternate = join(root, "child/other.json");
  writeFileSync(alternate, JSON.stringify(leaf));
  writeFileSync(parent, JSON.stringify({ ...parentDocument, roster: { enabled: true,
    roles: [{ agent_file: "../child/other.json" }] } }));
  await assert.rejects(launch((await load()).tools, resume), /changed.*agent_file/);
  writeFileSync(parent, JSON.stringify(parentDocument));
  for (const roster of [{ enabled: true, roles: [] },
    { enabled: false, roles: [{ agent_file: "./agent.json" }] }]) {
    writeFileSync(child, JSON.stringify({ ...leaf, roster }));
    await assert.rejects(load(), /non-Pi.*disabled.*empty|roster.*only.*pi/i);
  }
}

async function checkAgentFileResume(): Promise<void> {
  // Arrange: obtain a native ID through the named public launch.
  const { parent, child, document, parentDocument } = configureAgentFiles();
  const initial = await load();
  const first = await launch(initial.tools, { roster_entry: "night-owl", cwd: "./worktree",
    auto_approve: true, allowed_tools: ["read"] });
  const resume = { resume_session_id: first.details.sessionId };
  const restored = await load();
  // Act / Assert: branch restoration retains selections, but never restores permissions.
  const continued = report(await launch(restored.tools, resume));
  assert.equal(continued.cwd, join(root, "worktree"));
  assert.equal(continued.roster, child);
  assert.ok(continued.args.includes("child-model"));
  assert.ok(continued.args.includes("--no-approve"));
  assert.ok(!continued.args.includes("--tools"));
  assert.ok(continued.args.includes(first.details.sessionId));
  const edited = { ...document, agent: { ...document.agent, model: "edited-model" } };
  writeFileSync(child, JSON.stringify(edited));
  rmSync(started);
  for (const params of [{ roster_entry: "night-owl" }, resume]) {
    await assert.rejects(launch(restored.tools, params), /agent.*changed.*model.*reload/i);
    assert.equal(existsSync(started), false);
  }
  const listing = await restored.tools.get("subagent_roster")!.execute("list", {}, undefined,
    undefined, context);
  assert.equal(JSON.parse(listing.content[0].text)[0].model, "child-model");
  const reloaded = await load();
  await assert.rejects(launch(reloaded.tools, resume), /Original roster_entry changed.*model/);
  assert.ok(report(await launch(reloaded.tools, { roster_entry: "night-owl" }))
    .args.includes("edited-model"));

  // Each authoritative field must remain fixed, both before and after reload.
  writeFileSync(join(root, "child/other.md"), "# Another skill");
  for (const change of [{ name: "renamed" }, { description: "Changed purpose" },
    { agent_type: "codex", resources: {} }, { effort: "high" }, { cwd: "../worktree" },
    { resources: { skills: ["./other.md"] } }]) {
    writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent, ...change } }));
    rmSync(started, { force: true });
    await assert.rejects(launch(restored.tools, resume), /changed/i);
    const current = await load();
    await assert.rejects(launch(current.tools, resume), "agent_type" in change
      ? /roster_file.*only.*pi/i : /changed|Unknown roster entry/i);
    assert.equal(existsSync(started), false);
  }
  writeFileSync(child, JSON.stringify(document));
  const changedRoster = { ...document, roster: { enabled: true, roles: [] } };
  writeFileSync(child, JSON.stringify(changedRoster));
  await assert.rejects(launch(restored.tools, resume), /roster_file contents/);
  // New sessions see a changed child roster at call time without changing parent membership.
  await launch(restored.tools, { roster_entry: "night-owl" });
  writeFileSync(child, JSON.stringify(document));
  const alternate = join(root, "child/alternate.json");
  writeFileSync(alternate, JSON.stringify(document));
  writeFileSync(parent, JSON.stringify({ ...parentDocument, roster: { enabled: true,
    roles: [{ agent_file: "../child/alternate.json" }] } }));
  await assert.rejects(launch((await load()).tools, resume), /agent_file|roster_file/);
  writeFileSync(parent, JSON.stringify(parentDocument));
  rmSync(child);
  await assert.rejects(launch(restored.tools, resume), /agent.json/);
  writeFileSync(child, JSON.stringify(document));
  assert.equal(report(await launch(restored.tools, resume)).roster, child);
}

async function checkAgentFileValidation(): Promise<void> {
  // Arrange: validate via public extension loading, never a private parser seam.
  const { parent, child, document, parentDocument } = configureAgentFiles();
  const invalidAgents = [null, [], {}, ...["name", "description", "agent_type", "model", "effort"]
    .flatMap((key) => [{ ...document.agent, [key]: " " },
      { ...document.agent, [key]: null }]),
  ...["instructions", "roster_file", "alias", "agent_file", "enabled"]
    .map((key) => ({ ...document.agent, [key]: "unexpected" })),
  ...[{ cwd: "missing" }, { cwd: "skill.md" }, { cwd: "~" }, { cwd: "\0" },
    { resources: null }, { resources: [] }, { resources: { unknown: true } },
    { resources: { skills: "skill.md" } }, { resources: { skills: ["missing.md"] } },
    { resources: { extensions: ["npm:package"] } }, { resources: { plugins: ["https://x"] } },
    { resources: { packages: ["package"] } }, { resources: { mcp_servers: [{}] } },
    ...["inherit_personal_resources", "inherit_project_resources", "include_instruction_files",
      "include_home_system_prompt"].map((key) => ({ resources: { [key]: "false" } })),
  ].map((extra) => ({ ...document.agent, ...extra }))];
  const invalidDocuments = [null, [], {}, { agent: document.agent }, { roster: {} },
    { ...document, unknown: true }, { ...document, max_sub_agent_depth: 99 },
    ...invalidAgents.map((agent) => ({ ...document, agent })),
    ...[null, [], { enabled: "true" }, { roles: {} }, { unknown: false },
      { roles: [null] }, { roles: [{}] }, { roles: [{ agent_file: "./agent.json", model: "x" }] },
      { roles: [{ agent_file: "./agent.json", alias: "alias" }] },
      ...["", "missing.json", ".", "https://invalid", "npm:package", "~", "\0", null, 1]
        .map((agent_file) => ({ enabled: false, roles: [{ agent_file }] })),
    ].map((roster) => ({ ...document, roster }))];
  // Act / Assert: referenced invalid files fail even when the parent roster is disabled.
  for (const enabled of [true, false]) {
    writeFileSync(parent, JSON.stringify({ ...parentDocument,
      roster: { ...parentDocument.roster, enabled } }));
    for (const invalid of invalidDocuments) {
      writeFileSync(child, JSON.stringify(invalid));
      await assert.rejects(load(), (error: Error) => {
        assert.ok(error.message.includes(child), error.message);
        assert.match(error.message, /roster\.roles\[0\]/);
        return true;
      });
      assert.equal(existsSync(started), false);
    }
  }
  writeFileSync(child, "{");
  await assert.rejects(load(), /valid JSON/);
  rmSync(child);
  await assert.rejects(load(), /agent_file.*path/);
  writeFileSync(child, JSON.stringify(document));
  writeFileSync(parent, JSON.stringify({ ...parentDocument,
    roster: { enabled: false, roles: [parentDocument.roster.roles[0],
      parentDocument.roster.roles[0]] } }));
  await assert.rejects(load(), /duplicate roster role name "night-owl"/);
  // Top-level normalization cannot be used to smuggle policy or copied child settings.
  for (const invalid of [{ ...parentDocument, silent: true },
    { ...parentDocument, roster: { roles: [document.agent] } }]) {
    writeFileSync(parent, JSON.stringify(invalid));
    await assert.rejects(load(), /only|reference/);
  }
}

async function checkAgentFileCycles(): Promise<void> {
  // Arrange: both a self reference and a two-node cycle are valid files.
  const { child, document } = configureAgentFiles();
  writeFileSync(child, JSON.stringify({ ...document, roster: { enabled: true, roles: [
    { agent_file: "./agent.json" }, { agent_file: "../parent/agent.json" },
  ] } }));
  const cyclic = await load();
  // Act / Assert: traversal stops; runtime ancestry remains a separate launch policy.
  assert.equal(report(await launch(cyclic.tools, { roster_entry: "night-owl" })).depth, "1");
  const grandchild = join(root, "child/grandchild.json");
  const greatGrandchild = join(root, "child/great-grandchild.json");
  writeFileSync(grandchild, "{");
  writeFileSync(child, JSON.stringify({ ...document,
    roster: { enabled: true, roles: [{ agent_file: "grandchild.json" }] } }));
  const shallow = await load();
  const listing = await shallow.tools.get("subagent_roster")!.execute("list", {}, undefined,
    undefined, context);
  assert.equal(JSON.parse(listing.content[0].text)[0].name, "night-owl");
  rmSync(started);
  await assert.rejects(launch(shallow.tools, { roster_entry: "night-owl" }), /valid JSON/);
  assert.equal(existsSync(started), false);
  // Launching the child expands its immediate roster, but not a great-grandchild document.
  writeFileSync(greatGrandchild, "{");
  const grandchildDocument = { agent: { ...document.agent, name: "juniper" },
    roster: { enabled: false, roles: [{ agent_file: "great-grandchild.json" }] } };
  writeFileSync(grandchild, JSON.stringify(grandchildDocument));
  const first = await launch(shallow.tools, { roster_entry: "night-owl" });
  writeFileSync(grandchild, JSON.stringify({ ...grandchildDocument,
    agent: { ...grandchildDocument.agent, model: "new-grandchild-model" } }));
  await assert.rejects(launch(shallow.tools, { resume_session_id: first.details.sessionId }),
    /roster_file contents/);
  // The change affects a fresh launch's child roster, not its own model.
  assert.ok(report(await launch(shallow.tools, { roster_entry: "night-owl" }))
    .args.includes("child-model"));
}

async function checkAgentFileScoping(): Promise<void> {
  // Arrange: two unrelated agent names with distinct sources and working directories.
  const { parent, child, document, parentDocument } = configureAgentFiles();
  const other = join(root, "child/other.json");
  writeFileSync(other, JSON.stringify({ ...document, agent: { ...document.agent,
    name: "night-Owl", cwd: ".", resources: {} } }));
  writeFileSync(parent, JSON.stringify({ ...parentDocument, roster: { enabled: true,
    roles: [...parentDocument.roster.roles, { agent_file: "../child/other.json" }] } }));
  process.env.PI_AGENT_SHELL_CHILD = "1";
  process.env.PI_AGENT_SHELL_DEPTH = "1";
  process.env.PI_AGENT_SHELL_MAX_DEPTH = "2";
  writeFileSync(globalPath, '{"max_sub_agent_depth":99}');
  const before = { ...process.env };
  const selectedText = readFileSync(parent, "utf8");
  const { tools, commands, messages } = await load();
  // Act: concurrent launches must not share child selectors or overwrite the parent's policy.
  const [left, right, direct] = await Promise.all([
    launch(tools, { roster_entry: "night-owl", cwd: "worktree" }),
    launch(tools, { roster_entry: "night-Owl" }),
    launch(tools, { agent_type: "pi", cwd: "worktree", model: "direct-model" }),
  ]);
  assert.equal(report(left).roster, child);
  assert.equal(report(right).roster, other);
  assert.equal(report(right).cwd, join(root, "child"));
  assert.equal(report(direct).roster, null);
  for (const result of [left, right, direct]) {
    assert.equal(report(result).depth, "2");
    assert.equal(report(result).maxDepth, "2");
  }
  // Manual repeats must agree; overrides reject before native launch or background submission.
  rmSync(started);
  for (const mode of ["json", "rpc"] as const) {
    for (const params of [{ model: "wrong" }, { effort: "high" }, { agent_type: "codex" },
      { resources: {} }, { roster_file: parent }]) {
      await assert.rejects(launch(tools, { roster_entry: "night-owl", ...params }, mode),
        /conflict/i);
    }
    await assert.rejects(launch(tools, { roster_entry: "night-Owl", cwd: "worktree" }, mode),
      /Manual cwd conflicts/);
    await assert.rejects(launch(tools, { roster_entry: "NIGHT-OWL" }, mode),
      /Unknown roster entry/);
    assert.equal(existsSync(started), false);
    assert.equal(messages.length, 0);
  }
  const matching = report(await launch(tools, { roster_entry: "night-owl", agent_type: "pi",
    model: "child-model", effort: "low", resources: null, roster_file: null }));
  assert.equal(matching.roster, child);
  // roster_file remains a roster selector; it never imports the file's own launch settings.
  const adHoc = report(await launch(tools, { agent_type: "pi", roster_file: parent,
    model: "ad-hoc-model", effort: "medium", cwd: "worktree" }));
  assert.ok(adHoc.args.includes("ad-hoc-model"));
  assert.ok(!adHoc.args.includes("parent-model"));
  assert.equal(adHoc.cwd, join(root, "worktree"));
  await commands.get("agentshell-roster").handler("", context);
  await assert.rejects(launch(tools, { roster_entry: "night-owl" }), /Roster is disabled/);
  assert.equal(report(await launch(tools, { agent_type: "pi" })).roster, null);
  assert.equal(readFileSync(parent, "utf8"), selectedText);
  assert.equal(readFileSync(globalPath, "utf8"), '{"max_sub_agent_depth":99}');
  assert.deepEqual({ ...process.env }, before);
  assert.equal(report(await launch((await load()).tools, { roster_entry: "night-owl" })).roster,
    child);
  // An exhausted descendant cannot reset its depth through a different agent file.
  process.env.PI_AGENT_SHELL_DEPTH = "3";
  const exhausted = await load();
  assert.equal(exhausted.tools.size, 0);
}

async function checkAgentFileCapabilities(): Promise<void> {
  // Arrange: valid generic resource selections which Pi's native adapter cannot support.
  const { child, document } = configureAgentFiles();
  mkdirSync(join(root, "child/plugin"));
  for (const [resources, error] of [
    [{ plugins: ["./plugin"] }, /Pi uses extensions\/packages, not plugins/],
    [{ inherit_personal_resources: false }, /only together/],
    [{ inherit_personal_resources: false, inherit_project_resources: false },
      /requires mcp_servers/],
  ] as const) {
    writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent, resources } }));
    const { tools, messages } = await load();
    // Act / Assert: unsupported resources fail without starting the fake native agent.
    await assert.rejects(launch(tools, { roster_entry: "night-owl" }), error);
    const job = await launch(tools, { roster_entry: "night-owl" }, "rpc");
    assert.match(job.details.jobId, /^job-/);
    const deadline = Date.now() + 5_000;
    while (messages.length === 0 && Date.now() < deadline) await delay(10);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].details.status, "failed");
    assert.match(messages[0].content, error);
    assert.equal(existsSync(started), false);
  }
}

async function checkAgentFileOwnership(): Promise<void> {
  // Arrange: complete a background job and use the public delivered native ID.
  const { parent, child, document, parentDocument } = configureAgentFiles();
  const initial = await load();
  const job = await launch(initial.tools, { roster_entry: "night-owl", cwd: "worktree" }, "rpc");
  const deadline = Date.now() + 5_000;
  while (initial.messages.length === 0 && Date.now() < deadline) await delay(10);
  assert.equal(initial.messages.length, 1);
  const sessionId = initial.messages[0].content.match(/Session ID: (.+)$/)?.[1];
  assert.ok(sessionId && sessionId !== job.details.jobId);
  const resume = { resume_session_id: sessionId };
  const branch = [...history];
  // Act / Assert: navigation retains known selections; a reload restores only its branch.
  history.length = 0;
  await initial.handlers.get("session_tree")!({ type: "session_tree" }, context);
  await assert.rejects(launch(initial.tools, { ...resume, model: "wrong" }), /conflicts/);
  const unrelated = await load();
  await assert.rejects(launch(unrelated.tools, { ...resume, roster_entry: "night-owl" }),
    /No recorded launch/);
  history.push(...branch);
  await unrelated.handlers.get("session_tree")!({ type: "session_tree" }, context);
  const continued = report(await launch(unrelated.tools, resume));
  assert.equal(continued.cwd, join(root, "worktree"));
  assert.equal(continued.roster, child);
  assert.ok(continued.args.includes(sessionId));
  await assert.rejects(launch(unrelated.tools, { resume_session_id: job.details.jobId }),
    /native Session ID/);
  writeFileSync(parent, JSON.stringify({ ...parentDocument,
    roster: { ...parentDocument.roster, enabled: false } }));
  await assert.rejects(launch((await load()).tools, resume), /now disabled/);
  writeFileSync(parent, JSON.stringify(parentDocument));
  const otherParent = join(root, "parent/other.json");
  writeFileSync(otherParent, JSON.stringify(parentDocument));
  process.env.PI_AGENTSHELL_ROSTER_FILE = otherParent;
  await assert.rejects(launch((await load()).tools, resume), /roster source/);
  process.env.PI_AGENTSHELL_ROSTER_FILE = parent;
  // Same-path resource contents are intentionally not frozen, but removing selection is blocked.
  writeFileSync(join(root, "child/skill.md"), "# Revised skill contents");
  await launch(unrelated.tools, resume);
  const { resources: _resources, ...withoutResources } = document.agent;
  writeFileSync(child, JSON.stringify({ ...document, agent: withoutResources }));
  await assert.rejects(launch(unrelated.tools, resume), /Agent definition changed.*resources/);
  writeFileSync(child, JSON.stringify(document));
  writeFileSync(parent, JSON.stringify({ ...parentDocument,
    roster: { enabled: true, roles: [] } }));
  await assert.rejects(launch((await load()).tools, resume), /Unknown roster entry/);
  await unrelated.handlers.get("session_shutdown")!({ type: "session_shutdown" }, context);
}

async function assertNativeStopped(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await delay(10);
  }
  assert.fail(`Owned fake native process ${pid} survived cleanup`);
}

async function checkAgentFileInteractive(): Promise<void> {
  // Arrange: real SDK/tmux on a dedicated socket, with only the native agent doubled.
  const { child, document } = configureAgentFiles();
  writeFileSync(join(root, "bin/tmux"),
    `#!/bin/sh\nexec '${process.env.ROSTER_TMUX}' -f /dev/null `
      + `-S '${process.env.ROSTER_SOCKET}' "$@"\n`, { mode: 0o755 });
  writeFileSync(child, JSON.stringify({ ...document, agent: { ...document.agent,
    resources: { skills: ["skill.md"], inherit_personal_resources: false,
      inherit_project_resources: false, mcp_servers: [] } } }));
  const pidFile = join(root, "native.pid");
  process.env.ROSTER_PID_FILE = pidFile;
  const panes = () => {
    const result = spawnSync(process.env.ROSTER_TMUX!, ["-S", process.env.ROSTER_SOCKET!,
      "list-panes", "-t", "roster-test:0", "-F", "#{pane_id}"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").length;
  };
  assert.equal(panes(), 1);
  const initial = await load();
  // Act / Assert: a retained result does not prove the native session stopped.
  const retained = await launch(initial.tools, { roster_entry: "night-owl",
    interactive: true, stay_open: true, cwd: "worktree" });
  const native = report(retained);
  assert.equal(native.roster, child);
  assert.equal(native.cwd, join(root, "worktree"));
  assert.ok(native.args.includes(join(root, "child/skill.md")));
  assert.ok(native.args.includes("--no-skills"));
  assert.ok(native.args.includes("--no-mcp"));
  assert.equal(panes(), 2);
  const resume = { resume_session_id: retained.details.sessionId };
  await assert.rejects(launch(initial.tools, { ...resume, interactive: false }),
    /still be running/);
  const branch = [...history];
  history.length = 0;
  await initial.handlers.get("session_tree")!({ type: "session_tree" }, context);
  await assert.rejects(launch(initial.tools, { ...resume, agent_type: "pi" }), /still be running/);
  history.push(...branch);
  await initial.handlers.get("session_shutdown")!({ type: "session_shutdown" }, context);
  assert.equal(panes(), 1);
  await assertNativeStopped(pidFile);
  // Reload after cleanup permits a saved resume; native transcript truth stays the harness's job.
  const reloaded = await load();
  const continued = report(await launch(reloaded.tools, { ...resume, interactive: false }));
  assert.ok(continued.args.includes(retained.details.sessionId));
  assert.equal(continued.roster, child);
  await assertNativeStopped(pidFile);
  await launch(reloaded.tools, { roster_entry: "night-owl", interactive: true });
  assert.equal(panes(), 1);
  await assertNativeStopped(pidFile);
  await reloaded.handlers.get("session_shutdown")!({ type: "session_shutdown" }, context);
}

async function checkAgentFileCancellation(): Promise<void> {
  // Arrange: keep the fake native process waiting, without producing a completed session.
  configureAgentFiles();
  const pidFile = join(root, "native.pid");
  process.env.ROSTER_PID_FILE = pidFile;
  process.env.ROSTER_HOLD = "1";
  const { tools, messages, handlers } = await load();
  const job = await launch(tools, { roster_entry: "night-owl" }, "rpc");
  const startedBy = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < startedBy) await delay(10);
  assert.ok(existsSync(pidFile), "native process did not start");
  // Act: cancel via the public tool, then finish the owning session's lifecycle.
  await tools.get("subagent_cancel")!.execute("cancel", { job_id: job.details.jobId },
    undefined, undefined, context);
  const completedBy = Date.now() + 5_000;
  while (messages.length === 0 && Date.now() < completedBy) await delay(10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].details.status, "cancelled");
  await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context);
  // Assert: neither the worker nor its native child can be retained as a completed launch.
  await assertNativeStopped(pidFile);
  await assert.rejects(launch((await load()).tools, { roster_entry: "night-owl",
    resume_session_id: `roster-session-${readFileSync(pidFile, "utf8")}` }), /No recorded launch/);
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
    if (process.env.ROSTER_SCENARIO === "prompt-skills-interactive") {
      await checkInteractivePromptSkills();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "prompt-skill-scope") {
      await checkPromptSkillScope();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "prompt-skill-resume-codex"
      || process.env.ROSTER_SCENARIO === "prompt-skill-resume-claude") {
      await checkPromptSkillResume(process.env.ROSTER_SCENARIO.endsWith("codex")
        ? "codex" : "claude_code");
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "prompt-skill-membership") {
      await checkPromptSkillMembership();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "prompt-skill-native-options") {
      await checkPromptSkillNativeOptions();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "prompt-skill-failures") {
      await checkPromptSkillFailures();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "prompt-skill-directories") {
      await checkPromptSkillDirectories();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "claude-prompt-skills") {
      await checkClaudePromptSkills();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "codex-prompt-skills") {
      await checkCodexPromptSkills();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "native-reference-rejection") {
      await checkNativeReferenceRejection();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-duplicate-names") {
      await checkDistinctDuplicateNames();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-symlinks") {
      await checkAgentFileSymlinks();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "nested-diagnostic") {
      await checkNestedDiagnostic();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "inline-diagnostic") {
      await checkInlineDiagnostic();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files") {
      await checkAgentFiles();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-nonpi") {
      await checkAgentFileNonPi();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-resume") {
      await checkAgentFileResume();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-invalid") {
      await checkAgentFileValidation();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-cycles") {
      await checkAgentFileCycles();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-scoping") {
      await checkAgentFileScoping();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-capabilities") {
      await checkAgentFileCapabilities();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-ownership") {
      await checkAgentFileOwnership();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-interactive") {
      await checkAgentFileInteractive();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "agent-files-cancel") {
      await checkAgentFileCancellation();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "validation-order") {
      await checkValidationOrder();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
    if (process.env.ROSTER_SCENARIO === "ambiguous-resume") {
      await checkAmbiguousResume();
      process.stderr.write("ROSTER_LAUNCH_OK\n");
      return;
    }
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
      "ROSTER_PID_FILE", "ROSTER_HOLD", "ROSTER_INTERACTIVE_SOCKET",
      "PI_AGENT_SHELL_CHILD",
      "PI_AGENT_SHELL_DEPTH", "PI_AGENT_SHELL_MAX_DEPTH"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}
