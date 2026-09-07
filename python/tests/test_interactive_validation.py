import json
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
TMUX = shutil.which("tmux")

CLAUDE_TRUST_SCREEN = """
───────────────────────────────────────────────────────────
 Accessing workspace:

 /tmp/agentshell-live-workspace

 Quick safety check: Is this a project you created or one
 you trust? If not, take a moment to review what's in this
 folder first.

 Claude Code'll be able to read, edit, and execute files
 here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
""".strip()

COPILOT_TRUST_SCREEN = """
 [Current]  Sessions   Issues   Pull requests   Gists

                                                          ┃
 ● Tip: /remote                                           ┃
   └ Share this session: remote control from GitHub web   ┃
     and mobile, or directly with another CLI             ┃
                                                          ┃
╭─────────────────────────────────────────────────────────╮
│ Confirm folder trust                                    │
│ ─────────────────────────────────────────────────────── │
│ ╭─────────────────────────────────────────────────────╮ │
│ │ /tmp/agentshell-live-workspace                      │ │
│ ╰─────────────────────────────────────────────────────╯ │
│                                                         │
│ Copilot can read files in this folder and, with your    │
│ permission, edit them or run code and shell commands.   │
│ It will remember your permissions for the rest of this  │
│ session.                                                │
│                                                         │
│ Do you trust the files in this folder?                  │
│                                                         │
│ ❯ 1. Yes                                                │
│   2. Yes, and remember this folder for future sessions  │
│   3. No (Esc)                                           │
│                                                         │
│ ↑/↓ to navigate · enter to select · esc to cancel       │
╰─────────────────────────────────────────────────────────╯
""".strip()

CURSOR_TRUST_SCREEN = """
  ╭─────────────────────────────────────────────────────╮
  │                                                     │
  │  ⚠ Workspace Trust Required                         │
  │                                                     │
  │  Cursor Agent can execute code and access files in  │
  │  this directory.                                    │
  │                                                     │
  │  Do you trust the contents of this directory?       │
  │                                                     │
  │    /tmp/agentshell-live-workspace                   │
  │                                                     │
  │                                                     │
  │  ▶ [a] Trust this workspace                         │
  │    [q] Quit                                         │
  │                                                     │
  │  Use arrow keys to navigate, Enter to select, or    │
  │  press the key shown                                │
  │                                                     │
  ╰─────────────────────────────────────────────────────╯
""".strip()

PERMISSION_SCREEN = """
╭─────────────────────────────────────────────────────────╮
│ Allow Bash command?                                     │
│                                                         │
│ $ echo validation                                       │
│                                                         │
│ ❯ 1. Yes                                                │
│   2. No                                                 │
│                                                         │
│ Esc to cancel                                           │
╰─────────────────────────────────────────────────────────╯
""".strip()

# Cursor's compact onboarding view uses this exact prompt (from its onboarding UI).
LOGIN_SCREEN = """
Cursor Agent

Press any key to log in...
""".strip()

SHORT_HISTORICAL_MENU = """
Do you trust this folder?
❯ Yes
  No
Enter to select · Esc to cancel
""".strip()

SHORT_HISTORICAL_MENU_WITH_BORDER = """
Do you trust this folder?
❯ Yes
  No
  Allow
  Deny
  Trust
Enter to select · Esc to cancel
╰────────────────────────────────────────╯
""".strip()


class InteractiveValidationTest(unittest.TestCase):
    def test_claude_trust_prompt_does_not_complete_after_timeout(self) -> None:
        self.assert_trust_prompt_stays_active(
            "claude_code", "claude", CLAUDE_TRUST_SCREEN,
        )

    def test_copilot_trust_prompt_does_not_complete_after_timeout(self) -> None:
        self.assert_trust_prompt_stays_active(
            "copilot_cli", "copilot", COPILOT_TRUST_SCREEN,
        )

    def test_cursor_trust_prompt_does_not_complete_after_timeout(self) -> None:
        self.assert_trust_prompt_stays_active(
            "cursor", "cursor-agent", CURSOR_TRUST_SCREEN,
        )

    def test_permission_menu_does_not_complete_after_timeout(self) -> None:
        self.assert_prompt_stays_active(
            "claude_code", "claude", PERMISSION_SCREEN, "Allow Bash command?",
        )

    def test_login_prompt_does_not_complete_after_timeout(self) -> None:
        self.assert_prompt_stays_active(
            "cursor", "cursor-agent", LOGIN_SCREEN, "Press any key to log in...",
        )

    def test_historical_prompt_followed_by_answer_resumes_inactivity_timer(self) -> None:
        self.assertIsNotNone(TMUX)
        with tempfile.TemporaryDirectory(prefix="agentshell-validation-") as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            self.install_prompt_then_answer(
                fake_bin / "cursor-agent",
                PERMISSION_SCREEN,
                "FINAL_ANSWER_AFTER_PERMISSION",
            )
            socket_path = root / "tmux.sock"
            self.install_tmux_wrapper(fake_bin / "tmux", socket_path)
            session_name = self.start_tmux(socket_path)
            parent_pane = self.parent_pane(socket_path, session_name)
            process = self.start_worker(
                root,
                fake_bin,
                socket_path,
                parent_pane,
                {
                    "agent_type": "cursor",
                    "cwd": str(root),
                    "prompt": "return the answer",
                    "interactive": True,
                    "inactivity_timeout": 0.4,
                },
            )
            try:
                self.wait_for_prompt(
                    socket_path,
                    session_name,
                    "Allow Bash command?",
                )
                messages = self.read_until(process, "complete", timeout=5)
                process.wait(timeout=5)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(messages[-1], {"kind": "complete"})
                capture_event = next(
                    message["event"]
                    for message in messages
                    if message.get("kind") == "event" and
                    message["event"].get("type") == "text"
                )
                self.assertIn(
                    "FINAL_ANSWER_AFTER_PERMISSION",
                    capture_event["content"],
                )
                self.assertEqual(
                    self.panes(socket_path, session_name),
                    [parent_pane],
                )
            finally:
                self.stop_worker(process)
                self.kill_tmux(socket_path)

    def test_short_answer_after_historical_menu_allows_inactivity_completion(self) -> None:
        self.assert_historical_menu_answer_completes(
            SHORT_HISTORICAL_MENU,
            "FINAL_ANSWER: 42",
            "Do you trust this folder?",
        )
        self.assert_historical_menu_answer_completes(
            SHORT_HISTORICAL_MENU_WITH_BORDER,
            "FINAL_ANSWER_WITH_BORDER: 42",
            "Do you trust this folder?",
        )

    def assert_historical_menu_answer_completes(
        self,
        screen: str,
        answer: str,
        marker: str,
    ) -> None:
        self.assertIsNotNone(TMUX)
        with tempfile.TemporaryDirectory(prefix="agentshell-validation-") as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            self.install_prompt_then_answer(
                fake_bin / "cursor-agent",
                screen,
                answer,
                delay=0.15,
                padding_lines=0,
            )
            socket_path = root / "tmux.sock"
            self.install_tmux_wrapper(fake_bin / "tmux", socket_path)
            session_name = self.start_tmux(socket_path)
            parent_pane = self.parent_pane(socket_path, session_name)
            process = self.start_worker(
                root,
                fake_bin,
                socket_path,
                parent_pane,
                {
                    "agent_type": "cursor",
                    "cwd": str(root),
                    "prompt": "return the answer",
                    "interactive": True,
                    "inactivity_timeout": 0.4,
                },
            )
            try:
                self.wait_for_prompt(
                    socket_path,
                    session_name,
                    marker,
                )
                messages = self.read_until(process, "complete", timeout=4)
                process.wait(timeout=4)
                self.assertEqual(process.returncode, 0)
                capture_event = next(
                    message["event"]
                    for message in messages
                    if message.get("kind") == "event" and
                    message["event"].get("type") == "text"
                )
                self.assertIn(answer, capture_event["content"])
                self.assertEqual(
                    self.panes(socket_path, session_name),
                    [parent_pane],
                )
            finally:
                self.stop_worker(process)
                self.kill_tmux(socket_path)

    def test_finished_prose_allows_inactivity_completion(self) -> None:
        self.assertIsNotNone(TMUX)
        with tempfile.TemporaryDirectory(prefix="agentshell-validation-") as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            self.install_fake_cli(
                fake_bin / "cursor-agent",
                "The task is complete. Can we continue?",
            )
            socket_path = root / "tmux.sock"
            self.install_tmux_wrapper(fake_bin / "tmux", socket_path)
            session_name = self.start_tmux(socket_path)
            parent_pane = self.parent_pane(socket_path, session_name)
            process = self.start_worker(
                root,
                fake_bin,
                socket_path,
                parent_pane,
                {
                    "agent_type": "cursor",
                    "cwd": str(root),
                    "prompt": "return the answer",
                    "interactive": True,
                    "inactivity_timeout": 0.5,
                },
            )
            try:
                self.wait_for_prompt(
                    socket_path,
                    session_name,
                    "The task is complete. Can we continue?",
                )
                messages = self.read_until(process, "complete", timeout=4)
                process.wait(timeout=4)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(messages[-1]["kind"], "complete")
                capture_event = next(
                    message["event"]
                    for message in messages
                    if message.get("kind") == "event" and
                    message["event"].get("type") == "text"
                )
                self.assertIn(
                    "Terminal capture (heuristic; may be incomplete)",
                    capture_event["content"],
                )
                self.assertIn(
                    "The task is complete. Can we continue?",
                    capture_event["content"],
                )
                self.assertEqual(
                    self.panes(socket_path, session_name),
                    [parent_pane],
                )
            finally:
                self.stop_worker(process)
                self.kill_tmux(socket_path)

    def assert_trust_prompt_stays_active(
        self,
        agent_type: str,
        executable: str,
        screen: str,
    ) -> None:
        self.assert_prompt_stays_active(
            agent_type,
            executable,
            screen,
            {
                "claude_code": "Quick safety check: Is this a project you created",
                "copilot_cli": "Do you trust the files in this folder?",
                "cursor": "Workspace Trust Required",
            }[agent_type],
        )

    def assert_prompt_stays_active(
        self,
        agent_type: str,
        executable: str,
        screen: str,
        marker: str,
    ) -> None:
        self.assertIsNotNone(TMUX)
        with tempfile.TemporaryDirectory(prefix="agentshell-validation-") as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            self.install_fake_cli(
                fake_bin / executable,
                screen.replace("/tmp/agentshell-live-workspace", str(root)),
            )
            socket_path = root / "tmux.sock"
            self.install_tmux_wrapper(fake_bin / "tmux", socket_path)
            session_name = self.start_tmux(socket_path)
            parent_pane = self.parent_pane(socket_path, session_name)
            process = self.start_worker(
                root,
                fake_bin,
                socket_path,
                parent_pane,
                {
                    "agent_type": agent_type,
                    "cwd": str(root),
                    "prompt": "return the answer",
                    "interactive": True,
                    "inactivity_timeout": 0.5,
                },
            )
            try:
                self.wait_for_prompt(
                    socket_path,
                    session_name,
                    marker,
                )
                messages = self.read_for(process, timeout=1.5)
                self.assertNotIn(
                    "complete",
                    [message.get("kind") for message in messages],
                    messages,
                )
                self.assertIsNone(
                    process.poll(),
                    f"worker exited with messages={messages}",
                )
            finally:
                self.stop_worker(process)
                self.assertEqual(
                    self.panes(socket_path, session_name),
                    [parent_pane],
                )
                self.kill_tmux(socket_path)

    @staticmethod
    def install_fake_cli(path: Path, screen: str) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            f"screen = {screen!r}\n"
            "print(screen, flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_prompt_then_answer(
        path: Path,
        screen: str,
        answer: str,
        *,
        delay: float = 0.6,
        padding_lines: int = 13,
    ) -> None:
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import time\n"
            f"screen = {screen!r}\n"
            f"answer = {answer!r}\n"
            "print(screen, flush=True)\n"
            f"time.sleep({delay!r})\n"
            f"for index in range({padding_lines!r}):\n"
            "    print(f'output line {index}', flush=True)\n"
            "print(answer, flush=True)\n"
            "time.sleep(60)\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    @staticmethod
    def install_tmux_wrapper(path: Path, socket_path: Path) -> None:
        assert TMUX is not None
        path.write_text(
            "#!/bin/sh\n"
            f"exec {shlex.quote(TMUX)} -f /dev/null -S "
            f"{shlex.quote(str(socket_path))} \"$@\"\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    def start_tmux(self, socket_path: Path) -> str:
        session_name = f"agentshell-validation-{uuid.uuid4().hex}"
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
        return session_name

    def parent_pane(self, socket_path: Path, session_name: str) -> str:
        result = self.tmux(
            socket_path,
            "display-message",
            "-p",
            "-t",
            f"{session_name}:0.0",
            "#{pane_id}",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def start_worker(
        self,
        root: Path,
        fake_bin: Path,
        socket_path: Path,
        parent_pane: str,
        request: dict[str, object],
    ) -> subprocess.Popen[bytes]:
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
            cwd=root,
        )
        assert process.stdin is not None
        process.stdin.write((json.dumps(request) + "\n").encode())
        process.stdin.flush()
        return process

    @staticmethod
    def read_for(
        process: subprocess.Popen[bytes],
        *,
        timeout: float,
    ) -> list[dict[str, object]]:
        assert process.stdout is not None
        messages: list[dict[str, object]] = []
        pending = b""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select(
                [process.stdout], [], [], max(0.0, deadline - time.monotonic())
            )
            if not ready:
                break
            chunk = os.read(process.stdout.fileno(), 64 * 1024)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if line.strip():
                    messages.append(json.loads(line))
        return messages

    @classmethod
    def read_until(
        cls,
        process: subprocess.Popen[bytes],
        kind: str,
        *,
        timeout: float,
    ) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []
        pending = b""
        deadline = time.monotonic() + timeout
        assert process.stdout is not None
        while time.monotonic() < deadline:
            ready, _, _ = select.select(
                [process.stdout], [], [], max(0.0, deadline - time.monotonic())
            )
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
                message = json.loads(line)
                messages.append(message)
                if message.get("kind") == kind:
                    return messages
        stderr = ""
        if process.stderr is not None and process.poll() is not None:
            stderr = process.stderr.read().decode(errors="replace")
        raise AssertionError(
            f"worker did not emit {kind!r}; messages={messages}; stderr={stderr!r}"
        )

    @staticmethod
    def stop_worker(process: subprocess.Popen[bytes]) -> None:
        if process.poll() is None:
            if process.stdin is not None:
                process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        if process.stdin is not None:
            process.stdin.close()
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()

    def panes(self, socket_path: Path, session_name: str) -> list[str]:
        result = self.tmux(
            socket_path,
            "list-panes",
            "-t",
            f"{session_name}:0",
            "-F",
            "#{pane_id}",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip().splitlines()

    def kill_tmux(self, socket_path: Path) -> None:
        result = self.tmux(socket_path, "kill-server")
        self.assertIn(result.returncode, (0, 1), result.stderr)

    def wait_for_prompt(
        self,
        socket_path: Path,
        session_name: str,
        marker: str,
    ) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            panes = self.panes(socket_path, session_name)
            child_panes = [pane for pane in panes if pane != panes[0]]
            for pane in child_panes:
                capture = self.tmux(
                    socket_path,
                    "capture-pane",
                    "-p",
                    "-t",
                    pane,
                    "-S",
                    "-30",
                )
                self.assertEqual(capture.returncode, 0, capture.stderr)
                if marker in capture.stdout:
                    return
            time.sleep(0.05)

        self.fail(f"timed out waiting for prompt marker {marker!r}")

    @staticmethod
    def tmux(socket_path: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        assert TMUX is not None
        return subprocess.run(
            [TMUX, "-f", "/dev/null", "-S", str(socket_path), *arguments],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )


if __name__ == "__main__":
    unittest.main()
