#!/usr/bin/python3
"""Offline native process double and exact-handle observer; no inference or credentials."""
import array
import json
import os
from pathlib import Path
import select
import socket
import struct
import sys
import signal


def observe_native(socket_path, report_path):
    """Receive the live native process's own pidfd, then independently observe its exit."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(socket_path)
        server.listen(1)
        ready = select.poll()
        ready.register(server, select.POLLIN)
        ready.register(sys.stdin, select.POLLIN | select.POLLHUP)
        while True:
            for fd, _ in ready.poll(100):
                if fd == sys.stdin.fileno() and not os.read(fd, 1):
                    return  # A rejected launch never connects; EOF releases this owned observer.
                if fd != server.fileno():
                    continue
                with server.accept()[0] as connection:
                    connection.settimeout(2)
                    data, control, flags, _ = connection.recvmsg(8192, socket.CMSG_SPACE(4))
                    assert not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC)
                    handles = array.array("i")
                    for level, kind, value in control:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            handles.frombytes(value)
                    assert len(handles) == 1
                    handle = handles[0]
                    try:
                        peer, uid, _ = struct.unpack("3i", connection.getsockopt(
                            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
                        assert uid == os.getuid()
                        assert f"Pid:\t{peer}\n" in Path(f"/proc/self/fdinfo/{handle}").read_text()
                        poller = select.poll()
                        poller.register(handle, select.POLLIN)
                        assert not poller.poll(0), "native exited before handle capture"
                        record = {**json.loads(data), "alive_at_capture": True, "exited": False}
                        Path(report_path).write_text(json.dumps(record))
                        connection.sendall(b"R")
                        record["exited"] = bool(poller.poll(8000))
                        Path(report_path).write_text(json.dumps(record))
                        assert record["exited"], "original native handle survived shutdown"
                    finally:
                        os.close(handle)
                    return


if sys.argv[1:2] == ["--observe-native"]:
    observe_native(sys.argv[2], sys.argv[3])
    raise SystemExit(0)

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
if os.environ.get("ROSTER_INTERACTIVE_SOCKET"):
    # Codex/Claude interactive fixture: no forged native completion or session ID.
    handle = os.pidfd_open(os.getpid())
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(os.environ["ROSTER_INTERACTIVE_SOCKET"])
            connection.sendmsg([report.encode()], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                                   array.array("i", [handle]))])
            assert connection.recv(1) == b"R"
    finally:
        os.close(handle)
    print("OFFLINE_SKILL_DELIVERY", flush=True)
    signal.pause()  # The test owns this retained session and closes it via session_shutdown.
if os.environ.get("ROSTER_STARTED"):
    Path(os.environ["ROSTER_STARTED"]).write_text("started")
if os.environ.get("ROSTER_PID_FILE"):
    Path(os.environ["ROSTER_PID_FILE"]).write_text(str(os.getpid()))
if "--mode" in args and os.environ.get("ROSTER_HOLD") == "1":
    signal.pause()
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
