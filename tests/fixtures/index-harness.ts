import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../../index.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PYTHON_DIR = join(ROOT, "python");
const FAKE_BIN = join(PYTHON_DIR, "tests", "fixtures", "bin");

interface CapturedResult {
  content: Array<{ type: string; text: string }>;
  details: {
    status: string;
    sessionId?: string;
    outputTokens: number;
  };
}

interface CapturedTool {
  name: string;
  parameters: {
    required?: string[];
    properties?: {
        agent_type?: {
            enum?: string[];
        };
    };
  };
  execute: (...args: any[]) => Promise<CapturedResult>;
}

export default async function indexHarness(): Promise<void> {
  const tools: CapturedTool[] = [];

  const fakePi = {
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  await subagentsExtension(fakePi);

  assert.equal(tools.length, 1);

  const tool = tools[0];
  assert.ok(tool);
  assert.equal(tool.name, "subagent");
  assert.deepEqual(tool.parameters.required, ["agent_type", "prompt"]);

  const previousPath = process.env.PATH;
  process.env.PATH = FAKE_BIN;

  try {
    const result = await tool.execute(
      "index-test",
      {
        agent_type: "codex",
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );

    assert.deepEqual(result.content, [
      {
        type: "text",
        text: "test response",
      },
    ]);
    assert.equal(result.details.status, "ok");
    assert.equal(result.details.sessionId, "test-session");
    assert.equal(result.details.outputTokens, 7);

    const agentTypes = tool.parameters.properties?.agent_type?.enum;

    assert.ok(agentTypes);
    assert.ok(agentTypes.length > 0);
    assert.ok(agentTypes.includes("codex"));
    assert.equal(new Set(agentTypes).size, agentTypes.length);
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }

  process.stderr.write("INDEX_HARNESS_OK\n");
}
