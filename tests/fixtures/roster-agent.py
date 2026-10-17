#!/usr/bin/python3
"""Deterministic native Pi process double: no credentials, network or model calls."""
import json
import os
from pathlib import Path
import sys
import signal

args = sys.argv[1:]
session_id = (args[args.index("--session-id") + 1] if "--session-id" in args
              else f"roster-session-{os.getpid()}")
report = json.dumps({
    "args": args,
    "cwd": os.getcwd(),
    "roster": os.environ.get("PI_AGENTSHELL_ROSTER_FILE"),
    "home": os.environ.get("PI_CODING_AGENT_DIR"),
    "depth": os.environ.get("PI_AGENT_SHELL_DEPTH"),
    "maxDepth": os.environ.get("PI_AGENT_SHELL_MAX_DEPTH"),
})
if os.environ.get("ROSTER_STARTED"):
    Path(os.environ["ROSTER_STARTED"]).write_text("started")
events = [
    {"type": "session_start", "session_id": session_id},
    {"type": "message_update", "assistantMessageEvent": {
        "type": "text_end", "content": report,
    }},
    {"type": "agent_end", "messages": [{"role": "assistant", "stopReason": "stop"}]},
    {"type": "agent_settled", "session_id": session_id},
]
if "--mode" in args:
    print(json.dumps({"type": "session", "id": session_id}))
    for event in events[1:3]:
        print(json.dumps(event))
else:
    # AgentShell's public native Pi event extension writes here in interactive mode.
    event_file = Path(args[args.index("--extension") + 1]).parent / "events.jsonl"
    event_file.write_text("".join(json.dumps(event) + "\n" for event in events))
    signal.pause()
