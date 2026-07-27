import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { getSupportedAgentTypes, runAgentShell } from "../runner.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PYTHON_DIR = join(ROOT, "python");
const FAKE_BIN = join(PYTHON_DIR, "tests", "fixtures", "bin");

async function waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (!existsSync(path)) {
        if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for ${path}`);
        }

        await delay(10);
    }
}

test("gets supported agent types from AgentShell", async () => {
    const agentTypes = await getSupportedAgentTypes();
    assert.ok(agentTypes.length > 0);
    assert.ok(agentTypes.includes("codex"));
    assert.ok(agentTypes.every((agentType) => agentType.trim().length > 0));
    assert.equal(new Set(agentTypes).size, agentTypes.length);
});

test("runs the worker and returns its result", { timeout: 5_000 }, async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = FAKE_BIN;

    try {
        const result = await runAgentShell({
            agent_type: "codex",
            cwd: PYTHON_DIR,
            prompt: "Return a test response",
        });

        assert.equal(result.output, "test response");
        assert.equal(result.details.status, "ok");
        assert.equal(result.details.sessionId, "test-session");
        assert.equal(result.details.outputTokens, 7);
        assert.deepEqual(result.details.warnings, []);
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
    }
});

test("streams output before the worker exits", { timeout: 5_000 }, async () => {
    const previousPath = process.env.PATH;
    const previousResultDelay = process.env.FAKE_CODEX_RESULT_DELAY_SECONDS;

    process.env.PATH = FAKE_BIN;
    process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = "1";

    const updates: unknown[] = [];
    let resolveFirstUpdate: (() => void) | undefined;

    const firstUpdate = new Promise<void>((resolve) => {
        resolveFirstUpdate = resolve;
    });

    try {
        const execution = runAgentShell(
            {
                agent_type: "codex",
                cwd: PYTHON_DIR,
                prompt: "Return a streamed test response",
            },
            undefined,
            (update: unknown) => {
                updates.push(update);
                resolveFirstUpdate?.();
            },
        );

        const firstOutcome = await Promise.race([
            firstUpdate.then(() => "update"),
            execution.then(() => "result"),
        ]);

        assert.equal(firstOutcome, "update");
        assert.deepEqual(updates, [
            {
                output: "test response",
                details: {
                    status: "running",
                    sessionId: "test-session",
                    outputTokens: 0,
                    warnings: [],
                },
            },
        ]);

        const result = await execution;
        assert.equal(result.output, "test response");
        assert.equal(result.details.status, "ok");
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }

        if (previousResultDelay === undefined) {
            delete process.env.FAKE_CODEX_RESULT_DELAY_SECONDS;
        } else {
            process.env.FAKE_CODEX_RESULT_DELAY_SECONDS = previousResultDelay;
        }
    }
});

test("aborts a running AgentShell worker", { timeout: 10_000 }, async () => {
    const temporaryDirectory = mkdtempSync(
        join(tmpdir(), "pi-agentshell-cancel-"),
    );
    const startedFile = join(temporaryDirectory, "started");
    const previousPath = process.env.PATH;
    const previousStartedFile = process.env.FAKE_CODEX_STARTED_FILE;
    const previousDelay = process.env.FAKE_CODEX_DELAY_SECONDS;

    process.env.PATH = FAKE_BIN;
    process.env.FAKE_CODEX_STARTED_FILE = startedFile;
    process.env.FAKE_CODEX_DELAY_SECONDS = "2";

    try {
        const controller = new AbortController();
        const execution = runAgentShell(
            {
                agent_type: "codex",
                cwd: PYTHON_DIR,
                prompt: "Wait for cancellation",
            },
            controller.signal,
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
});
