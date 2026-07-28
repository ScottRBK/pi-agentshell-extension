import tempfile
import os
import json
import subprocess
import sys
import unittest
from agent_shell.models.agent import AgentType 

from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
WORKER = PYTHON_DIR / "worker.py"
FAKE_BIN = PYTHON_DIR / "tests" / "fixtures" / "bin"

class WorkerProtocolTest(unittest.TestCase):
    def test_lists_agent_types_from_agent_shell(self) -> None:
       completed, messages = self.run_worker({
           "operation": "list_agent_types",
       })

       self.assertEqual(
           completed.returncode,
           0,
           f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
       )
       self.assertEqual(
           messages,
           [
               {
                   "kind": "agent_types",
                   "agent_types": [
                       agent_type.value
                       for agent_type in AgentType
                   ],
               },
           ],
       )

    def test_fails_when_terminal_result_reports_error(self) -> None:
       request = {
           "agent_type": "claude_code",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
       }

       completed, messages = self.run_worker(request)

       self.assertEqual(
           completed.returncode,
           1,
           f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
       )
       self.assertEqual(
           [message["kind"] for message in messages],
           ["event"],
       )
       self.assertEqual(
           messages[0]["event"]["type"],
           "result",
       )
       self.assertEqual(
           messages[0]["event"]["content"],
           "error",
       )

    def test_forwards_agent_shell_warnings(self) -> None:
       request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
           "allowed_tools": ["Read"],
       }

       completed, messages = self.run_worker(request)

       self.assertEqual(
           completed.returncode,
           0,
           f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
       )
       self.assertEqual(
           messages[0],
           {
               "kind": "warning",
               "message": (
                   "Codex CLI has no per-call allowed_tools mechanism; ignoring"
               ),
           },
       )
       self.assertEqual(
           [message["kind"] for message in messages[1:]],
           ["event", "event", "event"],
       )

    def test_rejects_invalid_disallowed_tools(self) -> None:
       valid_request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
       }

       invalid_values = [
           (
               [],
               "disallowed_tools must be a non-empty list when provided",
           ),
           (
               "web_search",
               "disallowed_tools must be a non-empty list when provided",
           ),
           (
               ["web_search", " "],
               "disallowed_tools must contain only non-empty strings",
           ),
           (
               [123],
               "disallowed_tools must contain only non-empty strings",
           ),
       ]

       for value, expected_message in invalid_values:
           with self.subTest(value=value):
               request = {
                   **valid_request,
                   "disallowed_tools": value,
               }

               completed, messages = self.run_worker(request)

               self.assertEqual(
                   completed.returncode,
                   1,
                   f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
               )
               self.assertEqual(
                   messages,
                   [
                       {
                           "kind": "fatal",
                           "message": expected_message,
                       },
                   ],
               )

    def test_forwards_disallowed_tools_to_agent_shell(self) -> None:
       request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
           "disallowed_tools": ["web_search"],
       }

       with tempfile.TemporaryDirectory() as temp_directory:
           arguments_file = Path(temp_directory) / "arguments"

           completed, _messages = self.run_worker(
               request,
               extra_env={
                   "FAKE_CODEX_ARGS_FILE": str(arguments_file),
               },
           )

           arguments = arguments_file.read_text(
               encoding="utf-8",
           ).splitlines()

       self.assertEqual(
           completed.returncode,
           0,
           f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
       )
       self.assertIn(
           'web_search="disabled"',
           arguments,
       )

    def test_forwards_session_id_to_agent_shell(self) -> None:
       request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Continue the task",
           "session_id": "existing-session",
       }

       with tempfile.TemporaryDirectory() as temp_directory:
           arguments_file = Path(temp_directory) / "arguments"

           completed, _messages = self.run_worker(
               request,
               extra_env={
                   "FAKE_CODEX_ARGS_FILE": str(arguments_file),
               },
           )

           arguments = arguments_file.read_text(
               encoding="utf-8",
           ).splitlines()

       self.assertEqual(
           completed.returncode,
           0,
           f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
       )
       self.assertIn("resume", arguments)
       self.assertIn("existing-session", arguments)

    def test_rejects_invalid_optional_strings(self) -> None:
       valid_request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
       }

       for field in ("model", "effort", "session_id"):
           for value in (" ", 123):
               with self.subTest(field=field, value=value):
                   request = {
                       **valid_request,
                       field: value,
                   }

                   completed, messages = self.run_worker(request)

                   self.assertEqual(
                       completed.returncode,
                       1,
                       f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
                   )
                   self.assertEqual(
                       messages,
                       [
                           {
                               "kind": "fatal",
                               "message": (
                                   f"{field} must be a non-empty string when provided"
                               ),
                           },
                       ],
                   )

    def test_rejects_non_boolean_auto_approve(self) -> None:
       request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
           "auto_approve": "false",
       }

       completed, messages = self.run_worker(request)

       self.assertEqual(completed.returncode, 1)
       self.assertEqual(
           messages,
           [
               {
                   "kind": "fatal",
                   "message": "auto_approve must be a boolean",
               },
           ],
       )

    def tests_enables_auto_approval_when_explicitly_requested(self) -> None:
        request = {
            "agent_type": "codex",
            "cwd": str(PYTHON_DIR),
            "prompt": "Return a test reponse",
            "auto_approve": True
        }

        with tempfile.TemporaryDirectory() as temp_directory:
            arguments_file = Path(temp_directory) / "arguements"

            completed, _messages = self.run_worker(
                request,
                extra_env={
                    "FAKE_CODEX_ARGS_FILE": str(arguments_file),
                },
            )

            arguments = arguments_file.read_text(encoding="utf-8").splitlines()

            self.assertEqual(
                completed.returncode,
                0,
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
            self.assertIn('--dangerously-bypass-approvals-and-sandbox', arguments)


    def test_builds_safe_model_and_effort_to_agnet_shell(self) -> None:
        request = {
            "agent_type": "codex",
            "cwd": str(PYTHON_DIR),
            "prompt": "Return a test reponse",
            "model": "test-model",
            "effort": "high",
        }

        with tempfile.TemporaryDirectory() as temp_directory:
            arguments_file = Path(temp_directory) / "arguements"

            completed, _messages = self.run_worker(
                request,
                extra_env={
                    "FAKE_CODEX_ARGS_FILE": str(arguments_file),
                },
            )

            arguments = arguments_file.read_text(encoding="utf-8").splitlines()

            self.assertEqual(
                completed.returncode,
                0,
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
            self.assertIn("--model", arguments)
            model_index =  arguments.index("--model")
            self.assertEqual(arguments[model_index + 1], "test-model")
            self.assertIn('model_reasoning_effort="high"', arguments)
            self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', arguments)

    def test_fails_when_agent_shell_emits_an_error(self) -> None:
       request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Return a test response",
       }

       completed, messages = self.run_worker(
            request,
            extra_env= {"FAKE_CODEX_ERROR": "1"}
        )

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

        completed, messages = self.run_worker(
            request,
            extra_env={"FAKE_CODEX_NO_RESULT": "1"}
        )

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

        completed, messages = self.run_worker(request)

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


        completed, messages = self.run_worker(request=request)

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(
            messages,
            [
                {
                    "kind": "fatal",
                    "message": "unsupported agent type: not-an-agent"
                }
            ])
    def test_rejects_blank_required_strings(self) -> None:
       valid_request = {
           "agent_type": "codex",
           "cwd": str(PYTHON_DIR),
           "prompt": "Do something",
       }

       for field in ("agent_type", "cwd", "prompt"):
           with self.subTest(field=field):
               request = {
                   **valid_request,
                   field: " ",
               }

               completed, messages = self.run_worker(request)

               self.assertEqual(
                   completed.returncode,
                   1,
                   f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
               )
               self.assertEqual(
                   messages,
                   [
                       {
                           "kind": "fatal",
                           "message": f"{field} must be a non-empty string",
                       },
                   ],
               )
    def test_rejects_a_non_object_request(self) -> None:
       completed, messages = self.run_worker([
           "this",
           "is",
           "not",
           "an",
           "object",
       ])

       self.assertEqual(completed.returncode, 1)
       self.assertEqual(
           messages,
           [
               {
                   "kind": "fatal",
                   "message": "request must be a JSON object",
               },
           ],
       )

    def run_worker(
        self,
        request: object,
        *,
        extra_env: dict[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], list[dict[str,object]]]:
        env = os.environ.copy()


        if extra_env:
            env.update(extra_env)

        fake_codex = FAKE_BIN / "codex"

        if not os.access(fake_codex, os.X_OK):
            raise AssertionError(f"fake Codex is not executable: {fake_codex}")

        env["PATH"] = str(FAKE_BIN)


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

        return completed, messages

if __name__ == "__main__":
    unittest.main()
