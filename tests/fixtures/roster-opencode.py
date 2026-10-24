#!/usr/bin/python3
"""Native OpenCode double: report native skill selection without inference or services."""
import json
import os
from pathlib import Path
import sys

if os.environ.get("ROSTER_STARTED"):
    Path(os.environ["ROSTER_STARTED"]).write_text("started")
report = json.dumps({"args": sys.argv[1:], "cwd": os.getcwd(),
                     "config": json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}"))})
session_id = f"opencode-{os.getpid()}"
print(json.dumps({"type": "step_start", "sessionID": session_id}))
print(json.dumps({"type": "text", "part": {"text": report}}))
print(json.dumps({"type": "step_finish", "sessionID": session_id, "part": {"reason": "stop"}}))
