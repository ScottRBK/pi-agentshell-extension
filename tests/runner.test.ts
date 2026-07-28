import assert from "node:assert/strict";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getSupportedAgentTypes, runAgentShell } from "../runner.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PYTHON_DIR = join(ROOT, "python");
const FAKE_BIN = join(PYTHON_DIR, "tests", "fixtures", "bin");
const GENEROUS_LIMITS = {
    maxOutputBytes: 1024 * 1024,
    maxProtocolBytes: 2 * 1024 * 1024,
    maxMessageBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
};

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

test("stops and reports truncated output at the output limit", {
    timeout: 5_000,
}, async () => {
    const previousPath = process.env.PATH;
    const previousResponse = process.env.FAKE_CODEX_RESPONSE;

    process.env.PATH = FAKE_BIN;
    process.env.FAKE_CODEX_RESPONSE = "ab🙂cd";

    try {
        await assert.rejects(
            runAgentShell(
                {
                    agent_type: "codex",
                    cwd: PYTHON_DIR,
                    prompt: "Return too much output",
                },
                undefined,
                undefined,
                {
                    ...GENEROUS_LIMITS,
                    maxOutputBytes: 5,
                },
            ),
            {
                message: [
                    "AgentShell output exceeded the 5 byte limit. " +
                        "The agent was stopped.",
                    "Increase maxOutputBytes in your AgentShell extension " +
                        "configuration to override it.",
                    "",
                    "Partial output (truncated):",
                    "ab",
                ].join("\n"),
            },
        );
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }

        if (previousResponse === undefined) {
            delete process.env.FAKE_CODEX_RESPONSE;
        } else {
            process.env.FAKE_CODEX_RESPONSE = previousResponse;
        }
    }
});

test("stops when worker protocol exceeds the total limit", {
    timeout: 5_000,
}, async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = FAKE_BIN;

    try {
        await assert.rejects(
            runAgentShell(
                {
                    agent_type: "codex",
                    cwd: PYTHON_DIR,
                    prompt: "Exceed the protocol limit",
                },
                undefined,
                undefined,
                {
                    ...GENEROUS_LIMITS,
                    maxProtocolBytes: 200,
                    maxMessageBytes: 150,
                },
            ),
            {
                message: [
                    "AgentShell protocol exceeded the 200 byte limit. " +
                        "The agent was stopped.",
                    "Increase maxProtocolBytes in your AgentShell extension " +
                        "configuration to override it.",
                ].join("\n"),
            },
        );
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
    }
});

test("stops when one worker message exceeds its limit", {
    timeout: 5_000,
}, async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = FAKE_BIN;

    try {
        await assert.rejects(
            runAgentShell(
                {
                    agent_type: "codex",
                    cwd: PYTHON_DIR,
                    prompt: "Exceed the message limit",
                },
                undefined,
                undefined,
                {
                    ...GENEROUS_LIMITS,
                    maxMessageBytes: 100,
                },
            ),
            {
                message: [
                    "AgentShell protocol message exceeded the 100 byte limit. " +
                        "The agent was stopped.",
                    "Increase maxMessageBytes in your AgentShell extension " +
                        "configuration to override it.",
                ].join("\n"),
            },
        );
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
    }
});

test("stops when worker stderr exceeds its limit", {
    timeout: 5_000,
}, async () => {
    const temporaryExtension = mkdtempSync(
        join(tmpdir(), "pi-agentshell-stderr-"),
    );
    const temporaryBin = join(
        temporaryExtension,
        "python",
        ".venv",
        "bin",
    );

    try {
        mkdirSync(temporaryBin, { recursive: true });
        copyFileSync(
            join(ROOT, "runner.ts"),
            join(temporaryExtension, "runner.ts"),
        );
        copyFileSync(
            join(ROOT, "limits.ts"),
            join(temporaryExtension, "limits.ts"),
        );

        const temporaryPython = join(temporaryBin, "python");
        writeFileSync(
            temporaryPython,
            "#!/bin/sh\nprintf 'abcdef' >&2\n",
            "utf8",
        );
        chmodSync(temporaryPython, 0o755);

        const temporaryRunner = await import(
            pathToFileURL(join(temporaryExtension, "runner.ts")).href
        );

        await assert.rejects(
            temporaryRunner.runAgentShell(
                {
                    agent_type: "codex",
                    cwd: PYTHON_DIR,
                    prompt: "Exceed the stderr limit",
                },
                undefined,
                undefined,
                {
                    ...GENEROUS_LIMITS,
                    maxStderrBytes: 5,
                },
            ),
            {
                message: [
                    "AgentShell stderr exceeded the 5 byte limit. " +
                        "The agent was stopped.",
                    "Increase maxStderrBytes in your AgentShell extension " +
                        "configuration to override it.",
                ].join("\n"),
            },
        );
    } finally {
        rmSync(temporaryExtension, { recursive: true, force: true });
    }
});

test("reports agent failures with partial output", { timeout: 5_000 }, async () => {
    const previousPath = process.env.PATH;
    const previousError = process.env.FAKE_CODEX_ERROR;

    process.env.PATH = FAKE_BIN;
    process.env.FAKE_CODEX_ERROR = "1";

    try {
        await assert.rejects(
            runAgentShell({
                agent_type: "codex",
                cwd: PYTHON_DIR,
                prompt: "Fail after returning partial output",
            }),
            {
                message: [
                    "fake agent failed",
                    "",
                    "Partial output:",
                    "test response",
                ].join("\n"),
            },
        );
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }

        if (previousError === undefined) {
            delete process.env.FAKE_CODEX_ERROR;
        } else {
            process.env.FAKE_CODEX_ERROR = previousError;
        }
    }
});

test("reports worker fatal messages with partial output", {
    timeout: 5_000,
}, async () => {
    const previousPath = process.env.PATH;
    const previousNoResult = process.env.FAKE_CODEX_NO_RESULT;

    process.env.PATH = FAKE_BIN;
    process.env.FAKE_CODEX_NO_RESULT = "1";

    try {
        await assert.rejects(
            runAgentShell({
                agent_type: "codex",
                cwd: PYTHON_DIR,
                prompt: "End without a terminal result",
            }),
            {
                message: [
                    "agent stream ended without a terminal result",
                    "",
                    "Partial output:",
                    "test response",
                ].join("\n"),
            },
        );
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }

        if (previousNoResult === undefined) {
            delete process.env.FAKE_CODEX_NO_RESULT;
        } else {
            process.env.FAKE_CODEX_NO_RESULT = previousNoResult;
        }
    }
});

test("reports unsuccessful terminal results", { timeout: 5_000 }, async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = FAKE_BIN;

    try {
        await assert.rejects(
            runAgentShell({
                agent_type: "claude_code",
                cwd: PYTHON_DIR,
                prompt: "Report an unsuccessful result",
            }),
            {
                message: "claude_code reported an unsuccessful result",
            },
        );
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
    }
});

test("reports terminal failure reasons with partial output", {
    timeout: 5_000,
}, async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = FAKE_BIN;

    try {
        await assert.rejects(
            runAgentShell({
                agent_type: "pi",
                cwd: PYTHON_DIR,
                prompt: "Report a failed Pi result",
            }),
            {
                message: [
                    "model unavailable",
                    "",
                    "Partial output:",
                    "partial pi response",
                ].join("\n"),
            },
        );
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
