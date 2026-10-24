#!/usr/bin/python3
"""Native Codex double: no credentials, network or model calls."""
import json
import os
from pathlib import Path
import sys

if os.environ.get("ROSTER_STARTED"):
    Path(os.environ["ROSTER_STARTED"]).write_text("started")
report = json.dumps({"args": sys.argv[1:], "cwd": os.getcwd(),
                     "roster": os.environ.get("PI_AGENTSHELL_ROSTER_FILE")})
session_id = os.environ.get("ROSTER_SESSION_ID", f"codex-{os.getpid()}")
print(json.dumps({"type": "thread.started", "thread_id": session_id}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": report}}))
print(json.dumps({"type": "turn.completed", "usage": {"output_tokens": 1}}))
