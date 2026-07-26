import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath }  from "node:url";

import { runAgentShell } from "../runner.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PYTHON_DIR = join(ROOT, "python"); 
const FAKE_BIN = join(PYTHON_DIR, "tests", "fixtures", "bin");

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
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
    }
});


