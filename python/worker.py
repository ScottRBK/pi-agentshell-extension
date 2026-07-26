import asyncio
import json
import sys
import warnings

from dataclasses import asdict

from agent_shell.models.agent import AgentType
from agent_shell.shell import AgentShell



async def main() -> int:
    request = json.load(sys.stdin)

    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")

    if request.get("operation") == "list_agent_types": 
        emit({
            "kind": "agent_types",
            "agent_types": [
                agent_type.value
                for agent_type in AgentType
            ], 
        })
        return 0 

    raw_agent_type = require_string(request, "agent_type")
    cwd = require_string(request, "cwd")
    prompt = require_string(request, "prompt")
    model = optional_string(request, "model")
    effort = optional_string(request, "effort")
    auto_approve = request.get("auto_approve", False)
    disallowed_tools = optional_string_list(request, "disallowed_tools")
    allowed_tools = optional_string_list(request, "allowed_tools")

    if not isinstance(auto_approve, bool):
        raise ValueError("auto_approve must be a boolean")

    try:
        agent_type = AgentType(raw_agent_type)
        shell = AgentShell(agent_type=agent_type)
    except(TypeError, ValueError):
        raise ValueError(f"unsupported agent type: {raw_agent_type}")

    saw_result = False
    saw_error = False
    last_result_failed = False

    warnings.simplefilter("always")
    warnings.showwarning = emit_warning

    async for event in shell.stream(
        cwd=cwd,
        prompt=prompt,
        model=model,
        effort=effort,
        auto_approve=auto_approve,
        disallowed_tools=disallowed_tools,
        allowed_tools=allowed_tools,
    ):
        emit({
            "kind": "event",
            "event": asdict(event),
        })

        if event.type == "result":
            saw_result = True
            last_result_failed = event.content != "ok"
        elif event.type == "error":
            saw_error = True

    if saw_error or last_result_failed:
        return 1

    if not saw_result:
        raise RuntimeError("agent stream ended without a terminal result")

    return 0

def emit(message: dict[str, object]) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()

def emit_warning(message: Warning, *_args: object, **_kwargs: object) -> None:
    emit({
        "kind": "warning",
        "message": str(message),
    })

def require_string(request: dict[str, object], key:str) -> str:
    value = request.get(key)

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")

    return value

def optional_string(request: dict[str, object], key:str) -> str | None:
    value = request.get(key)

    if value is None:
        return None

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string when provided")

    return value

def optional_string_list(request: dict[str, object], key:str) -> list[str] | None:
    value = request.get(key)

    if value is None:
        return None

    if not isinstance(value, list) or not value:
        raise ValueError(f"{key} must be a non-empty list when provided")

    if not all(isinstance(item,str) and item.strip() for item in value):
        raise ValueError(f"{key} must contain only non-empty strings")

    return value

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


