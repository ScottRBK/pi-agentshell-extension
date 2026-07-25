import asyncio
import json 
import sys 

from dataclasses import asdict 

from agent_shell.models.agent import AgentType
from agent_shell.shell import AgentShell 



async def main() -> int: 
    request = json.load(sys.stdin)
    raw_agent_type = request.get("agent_type")
    try:
        agent_type = AgentType(raw_agent_type)
        shell = AgentShell(agent_type=agent_type)
    except(TypeError, ValueError):
        raise ValueError(f"unsupported agent type: {raw_agent_type}")

    saw_result = False 
    saw_error = False 

    async for event in shell.stream(cwd=request["cwd"], prompt=request["prompt"]):
        emit({
            "kind": "event",
            "event": asdict(event),
        })

        if event.type == "result":
            saw_result = True
        elif event.type == "error":
            saw_error = True 

    if saw_error:
        return 1

    if not saw_result:
        raise RuntimeError("agent stream ended without a terminal result")

    return 0

def emit(message: dict[str, object]) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()

async def run() -> int:
    try:
        return await main()
    except Exception as error:
        emit({
            "kind": "fatal",
            "message": str(error),
        })
        return 1 

if __name__ == "__main__": 
    raise SystemExit(asyncio.run(run()))


