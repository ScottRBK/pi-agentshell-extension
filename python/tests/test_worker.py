import os 
import json
import subprocess 
import sys
import unittest
from pathlib import Path 

PYTHON_DIR = Path(__file__).resolve().parents[1]
WORKER = PYTHON_DIR / "worker.py"
FAKE_BIN = PYTHON_DIR / "tests" / "fixtures" / "bin" 

class WorkerProtocolTest(unittest.TestCase):
    def test_fails_when_agent_shell_emits_an_error(self) -> None:
       request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Return a test response",
       }

       env = os.environ.copy()
       env["PATH"] = f"{FAKE_BIN}{os.pathsep}{env['PATH']}"
       env["FAKE_CODEX_ERROR"] = "1"

       completed = subprocess.run(
           [sys.executable, "-I", "-u", str(WORKER)],
           input=json.dumps(request),
           text=True,
           capture_output=True,
           check=False,
           timeout=5,
           env=env,
       )

       messages = [
           json.loads(line)
           for line in completed.stdout.splitlines()
           if line.strip()
       ]

       self.assertEqual(
           completed.returncode,
           1,
           f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
       )
       self.assertEqual(
           [message["kind"] for message in messages],
           ["event", "event", "event"],
       )
       self.assertEqual(
           [message["event"]["type"] for message in messages],
           ["session", "text", "error"],
       )
       self.assertEqual(
           messages[-1]["event"]["content"],
           "fake agent failed",
       )
    def test_fails_when_stream_has_no_terminal_result(self) -> None:
        request = {
            "agent_type": "codex",
            "cwd": str(PYTHON_DIR),
            "prompt": "Return a test response",
        }

        env = os.environ.copy()
        env["PATH"] = f"{FAKE_BIN}{os.pathsep}{env['PATH']}"
        env["FAKE_CODEX_NO_RESULT"] = "1"

        completed = subprocess.run(
            [sys.executable, "-I", "-u", str(WORKER)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
            env=env,
        )

        messages = [
            json.loads(line)
            for line in completed.stdout.splitlines()
            if line.strip() 
        ]

        self.assertEqual(
            completed.returncode,
            1, 
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertEqual(
            [message["kind"] for message in messages],
            ["event", "event", "fatal"]
        )
        self.assertEqual(
            [message["event"]["type"] for message in messages[:2]],
            ["session", "text"],
        )
        self.assertEqual(
            messages[-1],
            {
                "kind": "fatal",
                "message": "agent stream ended without a terminal result",
            }
        )

    def test_streams_events_from_agent_shell(self) -> None:
        request = {
            "agent_type": "codex",
            "cwd": str(PYTHON_DIR),
            "prompt": "Return a test response",
        }

        env = os.environ.copy()
        env["PATH"] = f"{FAKE_BIN}{os.pathsep}{env['PATH']}"

        completed = subprocess.run(
            [sys.executable, "-I", "-u", str(WORKER)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
            env=env,
        )

        messages = [
            json.loads(line)
            for line in completed.stdout.splitlines()
            if line.strip() 
        ]

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            [message["kind"] for message in messages],
            ["event", "event", "event"],
        )
        self.assertEqual(
            [message["event"]["type"] for message in messages[:3]],
            ["session", "text", "result"],
        )
        self.assertEqual(
            messages[1]["event"]["content"],
            "test response",
        )
        self.assertEqual(
            messages[2]["event"]["output_tokens"],
            7,
        )

    def test_rejects_an_unupported_agent_type(self) -> None:   
        request = {
            "agent_type": "not-an-agent",
            "cwd": str(PYTHON_DIR),
            "prompt": "Do something",
        }

        completed = subprocess.run(
            [sys.executable, "-I", "-u", str(WORKER)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )

        messages = [
            json.loads(line)
            for line in completed.stdout.splitlines()
            if line.strip()
        ]

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(
            messages,
            [
                {
                    "kind": "fatal",
                    "message": "unsupported agent type: not-an-agent"
                }
            ])

if __name__ == "__main__":
    unittest.main()
