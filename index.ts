import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getSupportedAgentTypes, runAgentShell } from "./runner.ts";


export default async function subagentsExtension(
    pi: ExtensionAPI,
): Promise<void> {
    if (process.env.PI_AGENT_SHELL_CHILD === "1") {
        return;
    }
    const agentTypes = await getSupportedAgentTypes() ;

    pi.registerTool({
        name: "subagent", 
        label: "Subagent",
        description: "Delegate a task to an AI coding agent in a separate context",
        parameters: Type.Object({
            agent_type: StringEnum(agentTypes, {
                description: "AgentShell agent type to run",
            }),
            prompt: Type.String({
                description: "Task for the subagent",
            }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const result = await runAgentShell({
                agent_type: params.agent_type,
                cwd: ctx.cwd,
                prompt: params.prompt,
            });

            return {
                content: [
                    {
                        type: "text",
                        text: result.output,
                    },
                ],
                details: result.details,
            };
        },
    });
}

