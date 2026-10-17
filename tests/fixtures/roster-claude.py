#!/usr/bin/python3
"""Native Claude Code double: report resources without credentials, network or model calls."""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if os.environ.get("ROSTER_STARTED"):
    Path(os.environ["ROSTER_STARTED"]).write_text("started")
report = json.dumps({"args": args, "roster": os.environ.get("PI_AGENTSHELL_ROSTER_FILE"),
                     "mcp": json.loads(Path(args[args.index("--mcp-config") + 1]).read_text())})
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": report}]}}))
print(json.dumps({"type": "result", "is_error": False, "session_id": f"claude-{os.getpid()}"}))
