import json
from contextlib import contextmanager
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


PYTHON_DIR = Path(__file__).resolve().parents[1]
WORKER = PYTHON_DIR / "worker.py"
CODEX_TITLE_TEXT = '{"title":"NOT_THE_VISIBLE_CODEX_926"}'
CODEX_ROOT_TEXT = '{"root":"NOT_THE_VISIBLE_CODEX_ROOT_926"}'
CODEX_VISIBLE_JSON = '{"answer":"VISIBLE_CODEX_JSON_926"}'


class InteractiveWorkerTest(unittest.TestCase):
    def test_interactive_rejects_unsupported_permission_controls(self) -> None:
        base_request = {
            "agent_type": "codex",
            "cwd": str(PYTHON_DIR),
            "prompt": "hello",
            "interactive": True,
        }
        cases = (
            (
                {"auto_approve": True},
                "auto_approve is not supported for interactive sessions",
            ),
            (
                {"disallowed_tools": ["bash"]},
                "disallowed_tools is not supported for interactive sessions",
            ),
            (
                {},
                "interactive sessions require TMUX and TMUX_PANE",
            ),
        )
        for extra, expected in cases:
            with self.subTest(extra=extra):
                environment = os.environ.copy()
                environment.pop("TMUX", None)
                environment.pop("TMUX_PANE", None)
                completed = subprocess.run(
                    [sys.executable, "-I", "-u", str(WORKER)],
                    input=(json.dumps({**base_request, **extra}) + "\n").encode(),
                    capture_output=True,
                    check=False,
                    timeout=5,
                    env=environment,
                )
                messages = [
                    json.loads(line)
                    for line in completed.stdout.decode().splitlines()
                    if line.strip()
                ]
                self.assertEqual(completed.returncode, 1, completed.stderr.decode())
                self.assertEqual(messages[0]["kind"], "fatal")
                self.assertIn(expected, messages[0]["message"])

    @contextmanager
    def launch_worker(
        self,
        binary_name,
        installer,
        request,
        *,
        intercept_second_capture=False,
    ):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            installer(fake_bin / binary_name)

            socket_path = root / "tmux.sock"
            self.install_tmux_wrapper(
                fake_bin / "tmux",
                socket_path,
                intercept_second_capture=intercept_second_capture,
            )
            session_name = f"agentshell-test-{uuid.uuid4().hex}"
            process = None
            try:
                self.start_tmux(socket_path, session_name)
                parent_pane = self.tmux(
                    socket_path,
                    "display-message",
                    "-p",
                    "-t",
                    f"{session_name}:0.0",
                    "#{pane_id}",
                ).stdout.strip()
                environment = os.environ.copy()
                environment.update({
                    "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
                    "TMUX": f"{socket_path},0,0",
                    "TMUX_PANE": parent_pane,
                })
                process = subprocess.Popen(
                    [sys.executable, "-I", "-u", str(WORKER)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=environment,
                )
                process.stdin.write((json.dumps({
                    **request,
                    "cwd": str(root),
                }) + "\n").encode())
                process.stdin.flush()
                yield process, root, socket_path, session_name, parent_pane
            finally:
                if process is not None:
                    if process.poll() is None:
                        if not process.stdin.closed:
                            process.stdin.close()
                        process.send_signal(signal.SIGTERM)
                        process.wait(timeout=5)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if not stream.closed:
                            stream.close()
                self.kill_tmux(socket_path)

    def test_codex_capture_completion_is_delivered_once_and_owned_pane_is_closed(self) -> None:
        with self.launch_worker(
            "codex", self.install_fake_codex,
            {
                "agent_type": "codex",
                "prompt": "hello",
                "interactive": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, root, socket_path, session_name, parent_pane):

            messages = self.read_until(process, "complete", timeout=5)

            process.wait(timeout=5)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(
                [message["kind"] for message in messages],
                ["warning", "event", "event", "complete"],
            )
            self.assertIn(
                "Terminal capture (heuristic; may be incomplete)",
                messages[1]["event"]["content"],
            )
            self.assertIn("READY", messages[1]["event"]["content"])
            self.assertEqual(messages[2]["event"]["type"], "result")
            self.assertEqual(
                sum(message["kind"] == "complete" for message in messages),
                1,
            )
            self.assertEqual(
                self.tmux(
                    socket_path,
                    "list-panes",
                    "-t",
                    f"{session_name}:0",
                    "-F",
                    "#{pane_id}",
                ).stdout.strip(),
                parent_pane,
            )

    def test_codex_uses_terminal_capture_instead_of_notify_text(self) -> None:
        for installer in (
            self.install_codex_notify_title_then_root,
            self.install_codex_notify_root_then_title,
        ):
            with self.subTest(installer=installer.__name__):
                with self.launch_worker(
                    "codex", installer,
                    {
                        "agent_type": "codex",
                        "prompt": "initial prompt",
                        "interactive": True,
                        "inactivity_timeout": 0.4,
                    },
                ) as (process, _root, _socket_path, _session_name, _parent_pane):
                    messages = self.read_until(process, "complete", timeout=3)
                    process.wait(timeout=5)

                    self.assertEqual(process.returncode, 0)
                    self.assertEqual(messages[0]["kind"], "warning")
                    self.assertIn("inferred", messages[0]["message"])
                    content = json.dumps(messages, ensure_ascii=False)
                    self.assertNotIn(CODEX_TITLE_TEXT, content)
                    self.assertNotIn(CODEX_ROOT_TEXT, content)
                    self.assertNotIn("notify-session-926", content)
                    self.assertNotIn("notify-root-session-926", content)
                    capture_event = next(
                        message["event"]
                        for message in messages
                        if message["kind"] == "event"
                        and message["event"]["type"] == "text"
                    )
                    self.assertIn(CODEX_VISIBLE_JSON, capture_event["content"])
                    self.assertIn(
                        "Terminal capture (heuristic; may be incomplete)",
                        capture_event["content"],
                    )

    def test_steering_is_sent_to_the_visible_terminal_and_completes_the_turn(self) -> None:
        with self.launch_worker(
            "codex", self.install_steering_codex,
            {
                "agent_type": "codex",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 1,
            },
        ) as (process, _root, socket_path, session_name, parent_pane):
            time.sleep(0.3)
            panes = self.tmux(
                socket_path,
                "list-panes",
                "-t",
                f"{session_name}:0",
                "-F",
                "#{pane_id}",
            ).stdout.splitlines()
            child_pane = next(pane for pane in panes if pane != parent_pane)
            self.tmux(socket_path, "send-keys", "-t", child_pane, "hello", "Enter")

            messages = self.read_until(process, "complete", timeout=5)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 0)
            self.assertEqual(messages[-1], {"kind": "complete"})
            self.assertEqual(
                [message["kind"] for message in messages],
                ["warning", "event", "event", "complete"],
            )
            self.assertEqual(messages[1]["event"]["type"], "text")
            self.assertIn("steered:hello", messages[1]["event"]["content"])
            self.assertEqual(messages[2]["event"]["type"], "result")

    def test_inactivity_fallback_labels_capture_and_warns_about_heuristic_completion(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_fake_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.6,
            },
        ) as (process, _root, socket_path, session_name, parent_pane):
            messages = self.read_until(process, "complete", timeout=5)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 0)
            self.assertEqual(
                [message["kind"] for message in messages],
                ["warning", "event", "event", "complete"],
            )
            self.assertIn("inferred", messages[0]["message"])
            self.assertIn(
                "Terminal capture (heuristic; may be incomplete)",
                messages[1]["event"]["content"],
            )
            self.assertIn("Answer accepted", messages[1]["event"]["content"])
            self.assertEqual(messages[2]["event"]["type"], "result")
            self.assertNotIn("error", messages[2]["event"])
            self.assertEqual(
                self.tmux(
                    socket_path,
                    "list-panes",
                    "-t",
                    f"{session_name}:0",
                    "-F",
                    "#{pane_id}",
                ).stdout.strip(),
                parent_pane,
            )

    def test_native_permission_menu_blocks_inactivity_fallback(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_permission_menu_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            time.sleep(0.9)
            ready, _, _ = select.select([process.stdout], [], [], 0)
            self.assertEqual(ready, [])

            process.stdin.close()
            process.wait(timeout=5)
            messages = [
                json.loads(line)
                for line in process.stdout.read().decode().splitlines()
                if line.strip()
            ]
            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[-1]["kind"], "fatal")
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_codex_capture_uses_visible_terminal_text(self) -> None:
        with self.launch_worker(
            "codex", self.install_codex_without_text,
            {
                "agent_type": "codex",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            messages = self.read_until(process, "complete", timeout=5)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 0)
            self.assertEqual(
                [message["kind"] for message in messages],
                ["warning", "event", "event", "complete"],
            )
            self.assertIn("notifications are ignored", messages[0]["message"])
            self.assertEqual(messages[1]["event"]["type"], "text")
            self.assertIn(
                "Terminal capture (heuristic; may be incomplete)",
                messages[1]["event"]["content"],
            )
            self.assertIn("visible answer", messages[1]["event"]["content"])
            self.assertEqual(messages[2]["event"]["type"], "result")

    def test_explicit_error_delivers_partial_terminal_capture_and_stops(self) -> None:
        with self.launch_worker(
            "codex", self.install_error_codex,
            {
                "agent_type": "codex",
                "prompt": "initial prompt",
                "interactive": True,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            messages = self.read_until(process, "fatal", timeout=5)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[0]["kind"], "event")
            self.assertEqual(messages[0]["event"]["type"], "error")
            self.assertIn("Invalid interactive event", messages[0]["event"]["content"])
            self.assertIn("may be incomplete", messages[1]["message"])
            self.assertEqual(messages[2]["event"]["type"], "text")
            self.assertIn(
                "Terminal capture (partial; may be incomplete)",
                messages[2]["event"]["content"],
            )
            self.assertIn("visible error", messages[2]["event"]["content"])
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_process_exit_delivers_partial_terminal_capture_and_stops(self) -> None:
        with self.launch_worker(
            "codex", self.install_failed_ephemeral_codex,
            {
                "agent_type": "codex",
                "prompt": "initial prompt",
                "interactive": True,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            messages = self.read_until(process, "fatal", timeout=5)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[0]["kind"], "event")
            self.assertEqual(messages[0]["event"]["type"], "process_exit")
            self.assertIn("may be incomplete", messages[1]["message"])
            self.assertEqual(messages[2]["event"]["type"], "text")
            self.assertIn(
                "Terminal capture (partial; may be incomplete)",
                messages[2]["event"]["content"],
            )
            self.assertIn("visible startup failure", messages[2]["event"]["content"])
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_nonzero_exit_before_event_grace_blocks_inferred_completion(self) -> None:
        with self.launch_worker(
            "codex", self.install_failed_exit_before_event_codex,
            {
                "agent_type": "codex",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 1,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            messages = self.read_until(process, "fatal", timeout=5)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[0]["event"]["type"], "process_exit")
            self.assertIn("may be incomplete", messages[1]["message"])
            self.assertIn(
                "FATAL: startup failed",
                messages[2]["event"]["content"],
            )
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_ordinary_prose_does_not_look_like_a_permission_prompt(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_ordinary_prose_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            messages = self.read_until(process, "complete", timeout=3)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 0)
            self.assertEqual(messages[0]["kind"], "warning")
            self.assertEqual(messages[-1], {"kind": "complete"})

    def test_native_steering_resets_inactivity_for_terminal_fallback(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_steering_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.6,
            },
        ) as (process, _root, socket_path, session_name, parent_pane):
            time.sleep(0.3)
            panes = self.tmux(
                socket_path,
                "list-panes",
                "-t",
                f"{session_name}:0",
                "-F",
                "#{pane_id}",
            ).stdout.splitlines()
            child_pane = next(pane for pane in panes if pane != parent_pane)
            self.tmux(socket_path, "send-keys", "-t", child_pane, "hello", "Enter")

            time.sleep(0.3)
            ready, _, _ = select.select([process.stdout], [], [], 0)
            self.assertEqual(ready, [])

            messages = self.read_until(process, "complete", timeout=3)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 0)
            self.assertEqual(messages[0]["kind"], "warning")
            capture_event = next(
                message["event"]
                for message in messages
                if message["kind"] == "event" and message["event"]["type"] == "text"
            )
            self.assertIn("Steering accepted: hello", capture_event["content"])

    def test_inactivity_can_be_disabled_until_parent_eof(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_fake_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.3,
                "inactivity_enabled": False,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            time.sleep(0.8)
            ready, _, _ = select.select([process.stdout], [], [], 0)
            self.assertEqual(ready, [])

            process.stdin.close()
            process.wait(timeout=5)
            messages = [
                json.loads(line)
                for line in process.stdout.read().decode().splitlines()
                if line.strip()
            ]
            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[-1]["kind"], "fatal")
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_known_busy_status_blocks_inactivity_fallback(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_busy_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            time.sleep(0.9)
            ready, _, _ = select.select([process.stdout], [], [], 0)
            self.assertEqual(ready, [])

            process.stdin.close()
            process.wait(timeout=5)
            messages = [
                json.loads(line)
                for line in process.stdout.read().decode().splitlines()
                if line.strip()
            ]
            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[-1]["kind"], "fatal")
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_completed_screen_after_busy_history_allows_inactivity_fallback(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_busy_then_done_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            messages = self.read_until(process, "complete", timeout=3)
            process.wait(timeout=5)

            self.assertEqual(process.returncode, 0)
            self.assertIn(
                "Terminal capture (heuristic; may be incomplete)",
                messages[1]["event"]["content"],
            )
            self.assertIn("Done.", messages[1]["event"]["content"])

    def test_inactivity_rechecks_final_terminal_screen_before_completion(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_prompt_on_input_cursor,
            {
                "agent_type": "cursor",
                "prompt": "initial prompt",
                "interactive": True,
                "inactivity_timeout": 0.1,
            },
            intercept_second_capture=True,
        ) as (process, _root, socket_path, session_name, parent_pane):
            time.sleep(0.8)
            self.assertIsNone(process.poll())

            panes = self.tmux(
                socket_path,
                "list-panes",
                "-t",
                f"{session_name}:0",
                "-F",
                "#{pane_id}",
            ).stdout.splitlines()
            child_pane = next(pane for pane in panes if pane != parent_pane)
            screen = self.tmux(
                socket_path,
                "capture-pane",
                "-p",
                "-J",
                "-S",
                "-",
                "-t",
                child_pane,
            ).stdout
            self.assertIn("Allow Bash command?", screen)

            process.stdin.close()
            process.wait(timeout=5)
            messages = [
                json.loads(line)
                for line in process.stdout.read().decode().splitlines()
                if line.strip()
            ]
            self.assertEqual(process.returncode, 1)
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_stay_open_delivers_once_and_closes_owned_pane_on_parent_eof(self) -> None:
        with self.launch_worker(
            "codex", self.install_fake_codex,
            {
                "agent_type": "codex",
                "prompt": "hello",
                "interactive": True,
                "stay_open": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, socket_path, session_name, parent_pane):
            messages = self.read_until(process, "complete", timeout=5)
            self.assertIsNone(process.poll())
            self.assertEqual(
                len(self.tmux(
                    socket_path,
                    "list-panes",
                    "-t",
                    f"{session_name}:0",
                    "-F",
                    "#{pane_id}",
                ).stdout.splitlines()),
                2,
            )
            self.assertEqual(
                sum(message["kind"] == "complete" for message in messages),
                1,
            )

            process.stdin.close()
            process.wait(timeout=5)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(
                self.tmux(
                    socket_path,
                    "list-panes",
                    "-t",
                    f"{session_name}:0",
                    "-F",
                    "#{pane_id}",
                ).stdout.strip(),
                parent_pane,
            )

    def test_stay_open_remains_alive_until_parent_eof(self) -> None:
        with self.launch_worker(
            "codex", self.install_stay_open_codex,
            {
                "agent_type": "codex",
                "prompt": "hello",
                "interactive": True,
                "stay_open": True,
                "inactivity_timeout": 0.4,
            },
        ) as (process, _root, socket_path, session_name, parent_pane):
            messages = self.read_until(process, "complete", timeout=5)
            time.sleep(2)

            self.assertIsNone(process.poll())
            self.assertEqual(
                len(self.tmux(
                    socket_path,
                    "list-panes",
                    "-t",
                    f"{session_name}:0",
                    "-F",
                    "#{pane_id}",
                ).stdout.splitlines()),
                2,
            )
            self.assertEqual(
                sum(message["kind"] == "complete" for message in messages),
                1,
            )

            process.stdin.close()
            process.wait(timeout=5)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(
                self.tmux(
                    socket_path,
                    "list-panes",
                    "-t",
                    f"{session_name}:0",
                    "-F",
                    "#{pane_id}",
                ).stdout.strip(),
                parent_pane,
            )

    def test_codex_capture_inactivity_can_be_disabled_until_parent_eof(self) -> None:
        with self.launch_worker(
            "codex", self.install_quiet_codex,
            {
                "agent_type": "codex",
                "prompt": "quiet",
                "interactive": True,
                "inactivity_timeout": 0.3,
                "inactivity_enabled": False,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            time.sleep(0.8)
            ready, _, _ = select.select([process.stdout], [], [], 0)
            self.assertEqual(ready, [])

            process.stdin.close()
            process.wait(timeout=5)
            output = process.stdout.read().decode()
            messages = [
                json.loads(line)
                for line in output.splitlines()
                if line.strip()
            ]
            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[-1]["kind"], "fatal")
            self.assertNotIn("complete", [message["kind"] for message in messages])

    def test_spinner_activity_does_not_trigger_false_completion(self) -> None:
        with self.launch_worker(
            "cursor-agent", self.install_spinner_cursor,
            {
                "agent_type": "cursor",
                "prompt": "spinner",
                "interactive": True,
                "inactivity_timeout": 0.5,
            },
        ) as (process, _root, _socket_path, _session_name, _parent_pane):
            time.sleep(1)
            ready, _, _ = select.select([process.stdout], [], [], 0)
            self.assertEqual(ready, [])

            process.stdin.close()
            process.wait(timeout=5)
            messages = [
                json.loads(line)
                for line in process.stdout.read().decode().splitlines()
                if line.strip()
            ]

            self.assertEqual(process.returncode, 1)
            self.assertEqual(messages[-1]["kind"], "fatal")
            self.assertNotIn("complete", [message["kind"] for message in messages])

    @staticmethod
    def install_fake_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json, subprocess, sys, tomllib\n"
            "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv "
            "if arg.startswith('notify='))\n"
            "assert all(__import__('os').isatty(fd) for fd in (0, 1, 2))\n"
            "print('READY', flush=True)\n"
            "subprocess.run(notify + [json.dumps({\n"
            "    'type': 'agent-turn-complete', 'thread-id': 'session',\n"
            "    'last-assistant-message': 'structured answer',\n"
            "})], check=True)\n"
            "input()\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_stay_open_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json, subprocess, sys, tomllib\n"
            "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv "
            "if arg.startswith('notify='))\n"
            "assert all(__import__('os').isatty(fd) for fd in (0, 1, 2))\n"
            "print('visible retained answer', flush=True)\n"
            "subprocess.run(notify + [json.dumps({\n"
            "    'type': 'agent-turn-complete', 'thread-id': 'session',\n"
            "    'last-assistant-message': 'structured answer',\n"
            "})], check=True)\n"
            "input()\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_codex_without_text(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json, subprocess, sys, tomllib\n"
            "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv "
            "if arg.startswith('notify='))\n"
            "assert all(__import__('os').isatty(fd) for fd in (0, 1, 2))\n"
            "print('visible answer', flush=True)\n"
            "subprocess.run(notify + [json.dumps({\n"
            "    'type': 'agent-turn-complete', 'thread-id': 'session',\n"
            "})], check=True)\n"
            "input()\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_codex_notify_title_then_root(path: Path) -> None:
        InteractiveWorkerTest.install_codex_notify_title(path, title_first=True)

    @staticmethod
    def install_codex_notify_root_then_title(path: Path) -> None:
        InteractiveWorkerTest.install_codex_notify_title(path, title_first=False)

    @staticmethod
    def install_codex_notify_title(path: Path, *, title_first: bool) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json, subprocess, sys, tomllib\n"
            "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv "
            "if arg.startswith('notify='))\n"
            f"title_first = {title_first!r}\n"
            f"title = {CODEX_TITLE_TEXT!r}\n"
            f"root = {CODEX_ROOT_TEXT!r}\n"
            f"visible = {CODEX_VISIBLE_JSON!r}\n"
            "title_record = json.dumps({\n"
            "    'type': 'agent-turn-complete',\n"
            "    'thread-id': 'notify-session-926',\n"
            "    'last-assistant-message': title,\n"
            "})\n"
            "root_record = json.dumps({\n"
            "    'type': 'agent-turn-complete',\n"
            "    'thread-id': 'notify-root-session-926',\n"
            "    'last-assistant-message': root,\n"
            "})\n"
            "records = ((title_record, root_record) if title_first else "
            "(root_record, title_record))\n"
            "if title_first:\n"
            "    for record in records:\n"
            "        subprocess.run(notify + [record], check=True)\n"
            "print(visible, flush=True)\n"
            "if not title_first:\n"
            "    for record in records:\n"
            "        subprocess.run(notify + [record], check=True)\n"
            "input()\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_error_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "from pathlib import Path\n"
            "import sys, time, tomllib\n"
            "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv "
            "if arg.startswith('notify='))\n"
            "Path(notify[-1]).write_text('{not-json\\n', encoding='utf-8')\n"
            "print('visible error', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_failed_ephemeral_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "print('visible startup failure', flush=True)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_failed_exit_before_event_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import sys, time\n"
            "print('FATAL: startup failed', flush=True)\n"
            "time.sleep(0.85)\n"
            "sys.exit(17)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_steering_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json, subprocess, sys, tomllib\n"
            "notify = next(tomllib.loads(arg)['notify'] for arg in sys.argv "
            "if arg.startswith('notify='))\n"
            "assert all(__import__('os').isatty(fd) for fd in (0, 1, 2))\n"
            "print('READY', flush=True)\n"
            "for line in sys.stdin:\n"
            "    if line.strip():\n"
            "        print('steered:' + line.strip(), flush=True)\n"
            "        subprocess.run(notify + [json.dumps({\n"
            "            'type': 'agent-turn-complete', 'thread-id': 'session',\n"
            "            'last-assistant-message': 'steered:' + line.strip(),\n"
            "        })], check=True)\n"
            "        break\n"
            "input()\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_steering_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import sys, time\n"
            "print('Initial output', flush=True)\n"
            "for line in sys.stdin:\n"
            "    if line.strip():\n"
            "        print('Steering accepted: ' + line.strip(), flush=True)\n"
            "        time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_fake_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "print('Allow this action? [y/N]', flush=True)\n"
            "print('Esc to cancel', flush=True)\n"
            "print('Answer accepted', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_permission_menu_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "print('Do you trust this folder?', flush=True)\n"
            "print('❯ Yes', flush=True)\n"
            "print('  No', flush=True)\n"
            "print('Enter to select · Esc to cancel', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_ordinary_prose_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "print('The task is complete. Can we continue?', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_quiet_codex(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "print('QUIET', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_busy_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "print('Thinking…', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_busy_then_done_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "print('Thinking...', flush=True)\n"
            "print('Done.', flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_prompt_on_input_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            "import sys\n"
            "print('stable answer', flush=True)\n"
            "for line in sys.stdin:\n"
            "    if line.strip():\n"
            "        print('Allow Bash command? [y/N]', flush=True)\n"
            "        print('Esc to cancel', flush=True)\n"
            "        time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_spinner_cursor(path: Path) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import sys, time\n"
            "frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'\n"
            "index = 0\n"
            "while True:\n"
            "    sys.stdout.write('\\rThinking ' + frames[index % len(frames)])\n"
            "    sys.stdout.flush()\n"
            "    index += 1\n"
            "    time.sleep(0.05)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_tmux_wrapper(
        path: Path,
        socket_path: Path,
        *,
        intercept_second_capture: bool = False,
    ) -> None:
        tmux_binary = shutil.which("tmux")
        if tmux_binary is None:
            raise unittest.SkipTest("tmux is required for interactive worker tests")
        tmux_command = shlex.quote(tmux_binary)
        socket = shlex.quote(str(socket_path))
        script = "#!/bin/sh\n"
        if intercept_second_capture:
            capture_count = shlex.quote(str(socket_path.with_suffix(".capture-count")))
            script += (
                "capture=0\n"
                "has_socket=0\n"
                "tmux_socket=''\n"
                "target=''\n"
                "previous=''\n"
                "for argument in \"$@\"; do\n"
                "  if [ \"$argument\" = \"capture-pane\" ]; then capture=1; fi\n"
                "  if [ \"$previous\" = \"-S\" ] && [ \"$argument\" != \"-\" ] && "
                "[ \"$has_socket\" -eq 0 ]; then\n"
                "    tmux_socket=\"$argument\"\n"
                "    has_socket=1\n"
                "  fi\n"
                "  if [ \"$previous\" = \"-t\" ]; then target=\"$argument\"; fi\n"
                "  previous=\"$argument\"\n"
                "done\n"
                "if [ \"$capture\" -eq 1 ]; then\n"
                f"  count=$(cat {capture_count} 2>/dev/null || printf '0')\n"
                "  count=$((count + 1))\n"
                f"  printf '%s\\n' \"$count\" > {capture_count}\n"
                "  if [ \"$count\" -eq 2 ] && [ -n \"$target\" ]; then\n"
                f"    if [ -z \"$tmux_socket\" ]; then tmux_socket={socket}; fi\n"
                f"    {tmux_command} -f /dev/null -S \"$tmux_socket\" send-keys "
                "-t \"$target\" trigger Enter\n"
                "    attempt=0\n"
                "    while [ \"$attempt\" -lt 20 ]; do\n"
                f"      screen=$({tmux_command} -f /dev/null -S \"$tmux_socket\" "
                "capture-pane -p -J -S - -t \"$target\")\n"
                "      case \"$screen\" in\n"
                "        *\"Allow Bash command?\"*) break ;;\n"
                "      esac\n"
                "      attempt=$((attempt + 1))\n"
                "      sleep 0.01\n"
                "    done\n"
                "  fi\n"
                "fi\n"
                f"if [ \"$has_socket\" -eq 0 ]; then set -- -f /dev/null -S {socket} \"$@\"; fi\n"
            )
            script += f"exec {tmux_command} \"$@\"\n"
        else:
            script += f"exec {tmux_command} -f /dev/null -S {socket} \"$@\"\n"
        path.write_text(script, encoding="utf-8")
        path.chmod(0o755)

    def start_tmux(self, socket_path: Path, session_name: str) -> None:
        result = self.tmux(
            socket_path,
            "new-session",
            "-d",
            "-s",
            session_name,
            "-x",
            "120",
            "-y",
            "40",
            "--",
            "sleep",
            "60",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @staticmethod
    def tmux(socket_path: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["tmux", "-f", "/dev/null", "-S", str(socket_path), *arguments],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )

    def kill_tmux(self, socket_path: Path) -> None:
        self.tmux(socket_path, "kill-server")

    @staticmethod
    def read_until(
        process: subprocess.Popen[bytes], kind: str, *, timeout: float,
    ) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []
        deadline = time.monotonic() + timeout
        pending = b""
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([process.stdout], [], [], remaining)
            if not ready:
                break
            chunk = os.read(process.stdout.fileno(), 64 * 1024)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if not line.strip():
                    continue
                messages.append(json.loads(line))
                if messages[-1].get("kind") == kind:
                    return messages
        stderr = process.stderr.read().decode() if process.poll() is not None else ""
        raise AssertionError(
            f"worker did not emit {kind!r} before timeout; messages={messages}; "
            f"stderr={stderr!r}"
        )

if __name__ == "__main__":
    unittest.main()
