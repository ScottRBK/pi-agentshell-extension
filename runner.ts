import { spawn } from "node:child_process"; 
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PYTHON = join(
    EXTENSION_DIRECTORY,
    "python", 
    ".venv",
    "bin", 
    "python",
); 

const WORKER = join(EXTENSION_DIRECTORY, "python", "worker.py");

export interface AgentRequest {
    agent_type: string; 
    cwd: string;
    prompt: string;
    model?: string;
    effort?: string;
    auto_approve?: boolean;
    allowed_tools?: string[];
    disallowed_tools?: string[];
}

export interface RunDetails {
    status: "ok" | "error";
    sessionId?: string;
    outputTokens: number;
}

export interface RunResult {
    output: string;
    details: RunDetails; 
}

interface AgentEvent {
    type: string;
    content: string;
    session_id?: string | null;
    output_tokens?: number;
}

interface WorkerMessage {
    kind: string; 
    event?: AgentEvent; 
}

export async function runAgentShell(
    request: AgentRequest, 
): Promise<RunResult> {
    const child = spawn(
        PYTHON,
        ["-I", "-u", WORKER],
        {
            stdio: ["pipe", "pipe", "pipe"], 
            env: {
                ...process.env,
                PI_AGENT_SHELL_CHILD: "1",
            },
        },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk; 
    });

    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve, reject) =>{
        child.once("error", reject);
        child.once("close", (code) => resolve(code));

        // A fast startup failure may close stdin before we finish writing. 
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(request)); 
    });

    const output: string[] = [];
    let status: RunDetails["status"] | undefined;
    let sessionId: string | undefined; 
    let outputTokens = 0;
    
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }

        const message = JSON.parse(line) as WorkerMessage;

        if (message.kind !== "event" || message.event === undefined) {
            throw new Error(
                `AgentShell worker emitted unsupported message: ${message.kind}`,
            );
        }

        const event = message.event; 

        if (event.type === "text") {
            output.push(event.content);
        }

        if (event.session_id) {
            sessionId = event.session_id; 
        }

        if (event.type === "result") {
            status = event.content === "ok" ? "ok" : "error";
            outputTokens = event.output_tokens ?? 0;
        }

    }

    if (exitCode !== 0) {
        const diagnostic = stderr.trim();
        const suffix = diagnostic ? `: ${diagnostic}` : "";

        throw new Error(
            `AgentShell worker exited with code ${exitCode}${suffix}`,
        );
    }

    if (status === undefined) {
        throw new Error("AgentShell worker exited without a terminal result");
    }

    return {
        output: output.join("\n"),
        details: {
            status,
            sessionId,
            outputTokens,
        },
    };
}
