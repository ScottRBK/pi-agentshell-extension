#!/usr/bin/python3
"""Native Copilot CLI double: no credentials, network or model calls."""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if os.environ.get("ROSTER_STARTED"):
    Path(os.environ["ROSTER_STARTED"]).write_text("started")
session_id = (args[args.index("--resume") + 1] if "--resume" in args
              else f"copilot-{os.getpid()}")
report = json.dumps({"args": args, "cwd": os.getcwd(),
                     "roster": os.environ.get("PI_AGENTSHELL_ROSTER_FILE")})
print(json.dumps({"type": "assistant.message", "data": {"content": report}}))
print(json.dumps({"type": "result", "exitCode": 0, "sessionId": session_id}))
