import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
      cwd?: {
        type?: string;
      };
    };
  };
  execute: (...args: any[]) => Promise<CapturedResult>;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }

    await delay(10);
  }
}

function assertSuccessfulResult(result: CapturedResult): void {
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "test response",
    },
  ]);
  assert.equal(result.details.status, "ok");
  assert.equal(result.details.sessionId, "test-session");
  assert.equal(result.details.outputTokens, 7);
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
  assert.equal(tool.parameters.properties?.cwd?.type, "string");

  const agentTypes = tool.parameters.properties?.agent_type?.enum;
  assert.ok(agentTypes);
  assert.ok(agentTypes.length > 0);
  assert.ok(agentTypes.includes("codex"));
  assert.equal(new Set(agentTypes).size, agentTypes.length);

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "pi-subagent-cwd-"),
  );
  const cwdFile = join(temporaryDirectory, "cwd");
  const startedFile = join(temporaryDirectory, "started");
  const overriddenCwd = join(temporaryDirectory, "overridden-cwd");
  mkdirSync(overriddenCwd);

  const previousPath = process.env.PATH;
  const previousCwdFile = process.env.FAKE_CODEX_CWD_FILE;
  const previousStartedFile = process.env.FAKE_CODEX_STARTED_FILE;
  const previousDelay = process.env.FAKE_CODEX_DELAY_SECONDS;
  process.env.PATH = FAKE_BIN;
  process.env.FAKE_CODEX_CWD_FILE = cwdFile;

  try {
    const defaultResult = await tool.execute(
      "index-test-default-cwd",
      {
        agent_type: "codex",
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );

    assertSuccessfulResult(defaultResult);
    assert.equal(
      readFileSync(cwdFile, "utf8").trim(),
      PYTHON_DIR,
    );

    const overriddenResult = await tool.execute(
      "index-test-overridden-cwd",
      {
        agent_type: "codex",
        cwd: overriddenCwd,
        prompt: "Return a test response",
      },
      undefined,
      undefined,
      { cwd: PYTHON_DIR },
    );

    assertSuccessfulResult(overriddenResult);
    assert.equal(
      readFileSync(cwdFile, "utf8").trim(),
      overriddenCwd,
    );

    process.env.FAKE_CODEX_STARTED_FILE = startedFile;
    process.env.FAKE_CODEX_DELAY_SECONDS = "2";

    const controller = new AbortController();
    const execution = tool.execute(
      "index-test-cancelled",
      {
        agent_type: "codex",
        prompt: "Wait for cancellation",
      },
      controller.signal,
      undefined,
      { cwd: PYTHON_DIR },
    );

    await waitForFile(startedFile);
    controller.abort();

    await assert.rejects(execution, {
      message: "aborted",
    });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    if (previousCwdFile === undefined) {
      delete process.env.FAKE_CODEX_CWD_FILE;
    } else {
      process.env.FAKE_CODEX_CWD_FILE = previousCwdFile;
    }

    if (previousStartedFile === undefined) {
      delete process.env.FAKE_CODEX_STARTED_FILE;
    } else {
      process.env.FAKE_CODEX_STARTED_FILE = previousStartedFile;
    }

    if (previousDelay === undefined) {
      delete process.env.FAKE_CODEX_DELAY_SECONDS;
    } else {
      process.env.FAKE_CODEX_DELAY_SECONDS = previousDelay;
    }

    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const childTools: CapturedTool[] = [];
  const childPi = {
    registerTool(tool: CapturedTool) {
      childTools.push(tool);
    },
  } as unknown as ExtensionAPI;

  const previousChildMarker = process.env.PI_AGENT_SHELL_CHILD;
  process.env.PI_AGENT_SHELL_CHILD = "1";

  try {
    await subagentsExtension(childPi);
    assert.deepEqual(childTools, []);
  } finally {
    if (previousChildMarker === undefined) {
      delete process.env.PI_AGENT_SHELL_CHILD;
    } else {
      process.env.PI_AGENT_SHELL_CHILD = previousChildMarker;
    }
  }

  process.stderr.write("INDEX_HARNESS_OK\n");
}
