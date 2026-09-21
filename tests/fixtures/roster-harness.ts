import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../../index.ts";

interface CapturedTool {
  name: string;
  description: string;
  execute: (...args: any[]) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

interface CapturedCommand {
  handler(args: string, ctx: {
    ui: { notify(message: string, type: string): void };
  }): Promise<void>;
}

const tools = new Map<string, CapturedTool>();
const commands = new Map<string, CapturedCommand>();
let active = ["read", "bash"];
const notices: string[] = [];

const pi = {
  registerTool(tool: CapturedTool) {
    tools.set(tool.name, tool);
    if (!active.includes(tool.name)) active.push(tool.name);
  },
  registerCommand(name: string, command: CapturedCommand) {
    commands.set(name, command);
  },
  registerMessageRenderer() {},
  on() {},
  getActiveTools() { return [...active]; },
  setActiveTools(names: string[]) { active = [...names]; },
} as unknown as ExtensionAPI;

await subagentsExtension(pi);

const configPath = join(
  process.env.PI_CODING_AGENT_DIR!,
  "extensions",
  "agentshell.json",
);
const command = commands.get("agentshell-roster");
const context = {
  ui: { notify(message: string) { notices.push(message); } },
};

assert.ok(command);
assert.ok(tools.get("subagent"));
assert.equal(tools.has("subagent_roster"), false);
assert.doesNotMatch(tools.get("subagent")!.description, /subagent_roster/);

await command.handler("", context);

assert.equal(active.includes("subagent_roster"), true);
assert.match(tools.get("subagent")!.description, /subagent_roster/);
const roster = await tools.get("subagent_roster")!.execute("roster-call", {});
assert.match(roster.content[0]!.text, /reviewer/);
assert.match(roster.content[0]!.text, /Review code for defects/);
assert.match(roster.content[0]!.text, /codex/);
assert.match(roster.content[0]!.text, /gpt-5/);
assert.match(roster.content[0]!.text, /high/);
assert.equal(JSON.parse(readFileSync(configPath, "utf8")).roster.enabled, true);

const reloadedTools = new Map<string, CapturedTool>();
const reloadedPi = {
  registerTool(tool: CapturedTool) { reloadedTools.set(tool.name, tool); },
  registerCommand() {},
  registerMessageRenderer() {},
  on() {},
} as unknown as ExtensionAPI;
await subagentsExtension(reloadedPi);
assert.ok(reloadedTools.get("subagent_roster"));
assert.match(reloadedTools.get("subagent")!.description, /subagent_roster/);

await command.handler("", context);

assert.equal(active.includes("subagent_roster"), false);
assert.doesNotMatch(tools.get("subagent")!.description, /subagent_roster/);
assert.equal(JSON.parse(readFileSync(configPath, "utf8")).roster.enabled, false);
assert.equal(notices.length, 2);

process.stderr.write("ROSTER_HARNESS_OK\n");

export default function rosterHarness(): void {}
