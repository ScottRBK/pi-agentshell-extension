import asyncio
import contextlib
import json
import math
import os
import re
import sys
import warnings

from dataclasses import asdict

from agent_shell.models.agent import AgentType
from agent_shell.models.agent import StreamEvent
from agent_shell.shell import AgentShell

_SCREEN_POLL_INTERVAL = 0.25
_PARTIAL_CAPTURE_LABEL = "Terminal capture (partial; may be incomplete)"
_ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_BUSY_STATUS = re.compile(
    r"^\s*(?:thinking|working|loading|generating|executing|processing|"
    r"waiting|planning|analy[sz]ing|running)"
    r"(?:\s*(?:\.{3}|…|[|/\\\-⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◴◷◵◶◰◳◲◱⏳∙⋯…]))?\s*$",
    re.IGNORECASE,
)
_PROMPT_FOOTER = re.compile(
    r"(?:\b(?:enter|return)\b.*\b(?:select|choose|confirm|submit)\b|"
    r"\besc(?:ape)?\b.*\bcancel\b|"
    r"\b(?:arrow|up\s*/?\s*down)\s+keys?\b.*\b(?:select|choose)\b|"
    r"\b(?:ctrl[- +]?c|press\s+(?:enter|return))\b.*\bcancel\b|"
    r"\bpress\s+the\s+key\s+shown\b)",
    re.IGNORECASE,
)
_PROMPT_QUESTION = re.compile(
    r"^\s*(?:[│|╭╰]\s*)?"
    r"(?:do you\s+(?:want|trust|approve|allow)\b|"
    r"would you\s+(?:like|allow)\b|"
    r"(?:allow|approve|authorize|authenticate|trust|permission)\b)"
    r".*\?\s*(?:\([^)]*\)|\[[^]]*\])?\s*$",
    re.IGNORECASE,
)
_PROMPT_OPTION = re.compile(
    r"^\s*(?:[❯>▶]\s*)?(?:\d+[.)]\s*)?"
    r"(?:\[[a-z]\]\s*)?"
    r"(?:yes|no|allow|deny|approve|reject|continue|cancel|exit|trust|quit)\b",
    re.IGNORECASE,
)
_PROMPT_LINE = re.compile(
    r"(?:\b(?:allow|approve|authorization|authorize|authenticate|authentication|"
    r"credentials?|login|log[ -]?in|password|passcode|api[ -]?key|token|"
    r"sign[ -]?in|trust)\b.*(?:[?:]|\[[^\]]*/[^\]]*\]|\([^)]*/[^)]*\])\s*$"
    r"|\s*\[[yn](?:\s*/\s*[yn])?\]\s*$"
    r"|\s*\([yn](?:\s*/\s*[yn])?\)\s*$"
    r"|\s*(?:enter|select|choose|type)\b.*[?:]\s*$"
    r"|\s*press\s+(?:enter|return)\b.*$"
    r"|\s*press\s+any\s+key\s+to\s+(?:log|sign)[ -]?in\b.*$)",
    re.IGNORECASE,
)


async def wait_for_stdin_eof() -> None:
    """Wait for the parent pipe to close without blocking terminal observation."""
    loop = asyncio.get_running_loop()
    fd = sys.stdin.buffer.fileno()
    future: asyncio.Future[None] = loop.create_future()

    def on_readable() -> None:
        if future.done():
            return
        try:
            data = os.read(fd, 64 * 1024)
        except BlockingIOError:
            return
        except OSError as error:
            future.set_exception(error)
            return
        if not data:
            future.set_result(None)
        # Interactive control is sent through the real tmux pane. Extra bytes on this
        # lifecycle pipe are deliberately ignored while EOF remains the close signal.

    try:
        loop.add_reader(fd, on_readable)
    except RuntimeError as error:
        raise RuntimeError(
            "interactive worker requires an event-loop readable stdin"
        ) from error
    try:
        await future
    finally:
        loop.remove_reader(fd)


class _InteractiveWorkerError(RuntimeError):
    pass



def _read_request() -> dict[str, object]:
    # The request is deliberately one newline-delimited object. For headless callers that
    # still send JSON+EOF, readline() returns the complete object at EOF as before.
    request_line = sys.stdin.readline()
    if not request_line.strip():
        raise ValueError("request must be a JSON object")
    request = json.loads(request_line)

    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    return request


async def main() -> int:
    request = _read_request()
    interactive = request.get("interactive", False)
    if not isinstance(interactive, bool):
        raise ValueError("interactive must be a boolean")
    if interactive:
        return await run_interactive(request)

    if request.get("operation") == "list_agent_types":
        emit({
            "kind": "agent_types",
            "agent_types": [
                agent_type.value
                for agent_type in AgentType
            ],
        })
        return 0

    if request.get("operation") == "list_models":
        raw_agent_type = require_string(request, "agent_type")
        cwd = require_string(request, "cwd")

        try:
            agent_type = AgentType(raw_agent_type)
            shell = AgentShell(agent_type=agent_type)
        except(TypeError, ValueError):
            raise ValueError(f"unsupported agent type: {raw_agent_type}")

        emit({
            "kind": "models",
            "models": await shell.list_models(cwd=cwd),
        })
        return 0

    raw_agent_type = require_string(request, "agent_type")
    cwd = require_string(request, "cwd")
    prompt = require_string(request, "prompt")
    model = optional_string(request, "model")
    effort = optional_string(request, "effort")
    session_id = optional_string(request, "session_id")
    auto_approve = request.get("auto_approve", False)
    disallowed_tools = optional_string_list(request, "disallowed_tools")
    allowed_tools = optional_string_list(request, "allowed_tools")

    if not isinstance(auto_approve, bool):
        raise ValueError("auto_approve must be a boolean")

    try:
        agent_type = AgentType(raw_agent_type)
        shell = AgentShell(agent_type=agent_type)
    except(TypeError, ValueError):
        raise ValueError(f"unsupported agent type: {raw_agent_type}")

    saw_result = False
    saw_error = False
    last_result_failed = False

    warnings.simplefilter("always")
    warnings.showwarning = emit_warning

    async for event in shell.stream(
        cwd=cwd,
        prompt=prompt,
        model=model,
        effort=effort,
        auto_approve=auto_approve,
        disallowed_tools=disallowed_tools,
        allowed_tools=allowed_tools,
        session_id=session_id,
        **session_resources(request),
    ):
        event_data = {
            key: value
            for key, value in asdict(event).items()
            if value is not None
        }
        emit({
            "kind": "event",
            "event": event_data,
        })

        if event.type == "result":
            saw_result = True
            last_result_failed = event.content != "ok"
        elif event.type == "error":
            saw_error = True

    if saw_error or last_result_failed:
        return 1

    if not saw_result:
        raise RuntimeError("agent stream ended without a terminal result")

    return 0


async def run_interactive(
    request: dict[str, object],
) -> int:
    """Run one visible AgentShell session and deliver its first completed turn."""
    raw_agent_type = require_string(request, "agent_type")
    cwd = require_string(request, "cwd")
    prompt = require_string(request, "prompt")
    model = optional_string(request, "model")
    effort = optional_string(request, "effort")
    session_id = optional_string(request, "session_id")
    allowed_tools = optional_string_list(request, "allowed_tools")
    disallowed_tools = optional_string_list(request, "disallowed_tools")
    auto_approve = request.get("auto_approve", False)
    if not isinstance(auto_approve, bool):
        raise ValueError("auto_approve must be a boolean")
    if auto_approve:
        raise ValueError(
            "auto_approve is not supported for interactive sessions; "
            "native permissions remain enabled"
        )
    if disallowed_tools is not None:
        raise ValueError(
            "disallowed_tools is not supported for interactive sessions; "
            "native permissions remain enabled"
        )

    stay_open = request.get("stay_open", False)
    if not isinstance(stay_open, bool):
        raise ValueError("stay_open must be a boolean")
    inactivity_enabled = request.get("inactivity_enabled", True)
    if not isinstance(inactivity_enabled, bool):
        raise ValueError("inactivity_enabled must be a boolean")
    inactivity_timeout = parse_inactivity_timeout(request.get("inactivity_timeout", 60))

    if not os.environ.get("TMUX") or not os.environ.get("TMUX_PANE"):
        raise ValueError(
            "interactive sessions require TMUX and TMUX_PANE; "
            "the AgentShell pane must be opened from tmux"
        )

    # Keep headless operation and model discovery compatible with older AgentShell runtimes;
    # only an interactive request needs the v0.4 tmux exports.
    from agent_shell import TmuxExecutionHost, TmuxPlacement

    try:
        agent_type = AgentType(raw_agent_type)
    except (TypeError, ValueError):
        raise ValueError(f"unsupported agent type: {raw_agent_type}") from None

    shell = AgentShell(
        agent_type=agent_type,
        execution_host=TmuxExecutionHost(TmuxPlacement.split_pane()),
    )
    session = None
    try:
        session = await shell.open_interactive(
            cwd=cwd,
            prompt=prompt,
            model=model,
            effort=effort,
            session_id=session_id,
            allowed_tools=allowed_tools,
            **session_resources(request),
        )
        await observe_interactive(
            session,
            stay_open=stay_open,
            inactivity_enabled=inactivity_enabled,
            inactivity_timeout=inactivity_timeout,
            codex_capture_only=agent_type == AgentType.CODEX,
        )
        return 0
    finally:
        if session is not None:
            with contextlib.suppress(BaseException):
                await session.close()


def session_resources(request: dict[str, object]) -> dict:
    if "resources" not in request:
        return {}
    # Lazy import keeps ordinary calls working with a previously installed runtime.
    try:
        from agent_shell.models.resources import SessionResources
    except ImportError as error:
        raise ValueError(
            "Session resources require AgentShell 0.5.0; update the runtime"
        ) from error
    value = request["resources"]
    if not isinstance(value, dict):
        raise ValueError("resources must be a JSON object")
    for key, setting in value.items():
        _validate_resource_setting(key, setting)
    return {"resources": SessionResources(**value)}


def _validate_resource_setting(key: str, setting: object) -> None:
    if key in {"packages", "mcp_servers"}:
        if key == "mcp_servers" and setting is None:
            return
        if setting != []:
            raise ValueError(
                f"resources.{key} supports only []; provision local files separately"
            )
    elif key in {"skills", "plugins", "extensions"}:
        _validate_resource_paths(key, setting)
    elif key in {"inherit_personal_resources", "inherit_project_resources",
                 "include_instruction_files", "include_home_system_prompt"}:
        if not isinstance(setting, bool):
            raise ValueError(f"resources.{key} must be a boolean")
    else:
        raise ValueError(f"Unknown resources setting {key!r}")


def _validate_resource_paths(key: str, setting: object) -> None:
    if not isinstance(setting, list) or any(
        not isinstance(path, str) or not path.strip() or "\u0000" in path
        for path in setting
    ):
        raise ValueError(f"resources.{key} must be an array of local paths")
    if any(re.match(r"^(?:[a-z]+:|~)", path, re.I) for path in setting):
        raise ValueError(f"resources.{key} requires provisioned local paths")


def parse_inactivity_timeout(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("inactivity_timeout must be a positive number")
    timeout = float(value)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("inactivity_timeout must be a positive number")
    return timeout


async def observe_interactive(
    session,
    *,
    stay_open: bool,
    inactivity_enabled: bool,
    inactivity_timeout: float,
    codex_capture_only: bool = False,
) -> None:
    monitor = _InteractiveMonitor(
        session,
        stay_open=stay_open,
        inactivity_enabled=inactivity_enabled,
        inactivity_timeout=inactivity_timeout,
        codex_capture_only=codex_capture_only,
    )
    await monitor.observe()


class _InteractiveMonitor:
    """Own the observations and activity state for one interactive turn."""

    def __init__(
        self,
        session,
        *,
        stay_open: bool,
        inactivity_enabled: bool,
        inactivity_timeout: float,
        codex_capture_only: bool,
    ) -> None:
        self.session = session
        self.stay_open = stay_open
        self.inactivity_enabled = inactivity_enabled
        self.inactivity_timeout = inactivity_timeout
        self.codex_capture_only = codex_capture_only
        self.events = session.events().__aiter__()
        self.event_task = asyncio.create_task(anext(self.events))
        self.screen_task = asyncio.create_task(session.terminal.capture_screen())
        self.eof_task = asyncio.create_task(wait_for_stdin_eof())
        self.tasks = {self.event_task, self.screen_task, self.eof_task}
        self.last_activity = asyncio.get_running_loop().time()
        self.last_screen_key: str | None = None
        self.latest_screen: str = ""
        self.structured_text = False

    async def observe(self) -> None:
        try:
            await self.wait_for_completion()
            if self.stay_open:
                await self.stop_observers()
                await wait_for_stdin_eof()
        finally:
            await self.stop_observers()

    async def wait_for_completion(self) -> None:
        while True:
            done, _pending = await asyncio.wait(
                self.tasks,
                timeout=0.05,
                return_when=asyncio.FIRST_COMPLETED,
            )
            # EOF wins over screen/event observations; screen precedes harness events.
            self.observe_terminal(done)
            if self.event_task in done:
                event = self.take_event()
                if self.ignores_event(event):
                    self.request_next_event()
                    continue
                await self.report_event(event)
                if event.type == "result":
                    if await self.complete_reported_turn():
                        return
                    self.request_next_event()
                    continue
                self.request_next_event()
            # The continue branches above deliberately skip inference for this iteration.
            if await self.infer_completion():
                return

    def observe_terminal(self, done: set[asyncio.Task]) -> None:
        if self.eof_task in done:
            self.eof_task.result()
            raise _InteractiveWorkerError(
                "interactive worker input closed before completion"
            )
        if self.screen_task not in done:
            return
        self.tasks.discard(self.screen_task)
        try:
            self.latest_screen = self.screen_task.result()
        except Exception as error:
            raise _InteractiveWorkerError(
                f"could not inspect interactive terminal: {error}"
            ) from error
        else:
            self.record_screen_activity()
        self.screen_task = asyncio.create_task(
            capture_screen_after_delay(self.session, _SCREEN_POLL_INTERVAL)
        )
        self.tasks.add(self.screen_task)

    def record_screen_activity(self) -> None:
        screen_key = normalize_screen(self.latest_screen)
        if screen_key != self.last_screen_key:
            self.last_screen_key = screen_key
            self.last_activity = asyncio.get_running_loop().time()
        # A visible permission/login prompt suspends heuristic completion. A prompt may
        # be in retained scrollback, so inspect only the current tail. Real screen changes
        # during busy work reset the timer, and known busy statuses keep it suspended.
        if is_interactive_prompt(self.latest_screen):
            self.last_activity = asyncio.get_running_loop().time()
        if is_interactive_busy(self.latest_screen):
            self.last_activity = asyncio.get_running_loop().time()

    def take_event(self) -> StreamEvent:
        self.tasks.discard(self.event_task)
        try:
            return self.event_task.result()
        except StopAsyncIteration:
            raise _InteractiveWorkerError(
                "interactive harness exited before reporting a completed turn"
            )
        except Exception as error:
            raise _InteractiveWorkerError(str(error)) from error

    def ignores_event(self, event: StreamEvent) -> bool:
        # Codex's notify hook can provide stale or unrelated assistant text. Its
        # turn-complete capability is therefore ignored in favor of the visible UI.
        return self.codex_capture_only and event.type in {"system", "text", "result"}

    def request_next_event(self) -> None:
        self.event_task = asyncio.create_task(anext(self.events))
        self.tasks.add(self.event_task)

    async def report_event(self, event: StreamEvent) -> None:
        emit_event(event)
        if event.type in {"system", "status", "tool_use", "text"}:
            self.last_activity = asyncio.get_running_loop().time()
        if event.type == "text":
            self.structured_text = self.structured_text or bool(event.content.strip())
        if event.type == "error":
            await self.capture_unstructured_output(
                _PARTIAL_CAPTURE_LABEL,
                "Interactive harness reported an error before structured output; "
                "terminal capture may be incomplete.",
            )
            raise _InteractiveWorkerError(
                event.content or "interactive harness reported an error"
            )
        if event.type == "process_exit":
            await self.capture_unstructured_output(
                _PARTIAL_CAPTURE_LABEL,
                "Interactive harness exited before structured output; terminal "
                "capture may be incomplete.",
            )
            raise _InteractiveWorkerError(
                "interactive harness exited before reporting a completed turn"
            )
        if event.type == "result" and event.content != "ok":
            await self.capture_unstructured_output(
                _PARTIAL_CAPTURE_LABEL,
                "Interactive harness reported an unsuccessful result "
                "before structured output; terminal capture may be incomplete.",
            )
            reason = event.error or "interactive harness reported an unsuccessful result"
            raise _InteractiveWorkerError(reason)

    async def complete_reported_turn(self) -> bool:
        if "turn_complete" not in self.session.capabilities:
            return False
        await self.capture_unstructured_output(
            "Terminal capture (may be incomplete)",
            "Interactive result had no structured text; terminal capture "
            "may be incomplete.",
        )
        await self.deliver_complete()
        return True

    async def deliver_complete(self) -> None:
        if not self.stay_open and not self.session.terminal.closed:
            await self.session.close()
        emit({"kind": "complete"})

    async def stop_observers(self) -> None:
        current = tuple(self.tasks)
        self.tasks.clear()
        for task in current:
            task.cancel()
        await asyncio.gather(*current, return_exceptions=True)

    async def capture_unstructured_output(self, label: str, warning: str) -> None:
        if not self.structured_text:
            await self.emit_terminal_capture(label, warning)

    async def emit_terminal_capture(
        self,
        label: str,
        warning: str | None = None,
        screen: str | None = None,
    ) -> None:
        if screen is None:
            try:
                captured_screen: str = await self.session.terminal.capture_screen()
                screen = captured_screen
            except Exception as error:
                raise _InteractiveWorkerError(
                    f"could not capture interactive terminal: {error}"
                ) from error
        self.latest_screen = screen
        if warning is not None:
            emit({"kind": "warning", "message": warning})
        capture = screen or "<empty terminal capture>"
        emit_event(StreamEvent(
            type="text",
            content=f"{label}:\n{capture}",
        ))

    def can_infer_completion(self) -> bool:
        now = asyncio.get_running_loop().time()
        return not (
            (not self.codex_capture_only and "turn_complete" in self.session.capabilities)
            or not self.inactivity_enabled
            or self.session.terminal.returncode is not None
            or now - self.last_activity < self.inactivity_timeout
        )

    async def infer_completion(self) -> bool:
        if not self.can_infer_completion():
            return False
        try:
            refreshed_screen = await self.session.terminal.capture_screen()
        except Exception as error:
            raise _InteractiveWorkerError(
                f"could not inspect interactive terminal: {error}"
            ) from error
        refreshed_key = normalize_screen(refreshed_screen)
        self.latest_screen = refreshed_screen
        if refreshed_key != self.last_screen_key:
            self.last_screen_key = refreshed_key
            self.last_activity = asyncio.get_running_loop().time()
            return False
        if self.event_task.done() or self.screen_task.done() or self.eof_task.done():
            # Process completed lifecycle, harness, or screen observations in the main
            # loop before deciding that the turn is idle.
            return False
        if self.session.terminal.returncode is not None:
            # The process may have exited while the awaited screen refresh was running;
            # let the session's event grace deliver process_exit instead of inferring success.
            return False
        if is_interactive_prompt(refreshed_screen) or is_interactive_busy(refreshed_screen):
            self.last_activity = asyncio.get_running_loop().time()
            return False
        if asyncio.get_running_loop().time() - self.last_activity < self.inactivity_timeout:
            return False

        emit({"kind": "warning", "message": self.inactivity_warning()})
        if not self.structured_text:
            await self.emit_terminal_capture(
                "Terminal capture (heuristic; may be incomplete)",
                screen=refreshed_screen,
            )
        # Keep existing consumers' terminal-result contract. The warning explicitly
        # records that this result was inferred rather than proven by the harness.
        emit_event(StreamEvent(type="result", content="ok"))
        await self.deliver_complete()
        return True

    def inactivity_warning(self) -> str:
        if self.codex_capture_only:
            return (
                "Codex interactive uses interim terminal-capture mode: completion "
                "notifications are ignored because their payload is unreliable; "
                "completion was inferred after "
                f"{self.inactivity_timeout:g} seconds of inactivity, and terminal capture "
                "may be incomplete."
            )
        return (
            "Interactive completion was inferred after "
            f"{self.inactivity_timeout:g} seconds of inactivity; "
            "the harness did not report a completed turn."
        )


async def capture_screen_after_delay(session, delay: float) -> str:
    await asyncio.sleep(delay)
    return await session.terminal.capture_screen()


def normalize_screen(screen: str) -> str:
    """Remove terminal control and incidental whitespace before comparing screen activity."""
    screen = _ANSI_ESCAPE.sub("", screen).replace("\r", "")
    return "\n".join(line.rstrip() for line in screen.splitlines()).strip()


def _visible_screen_tail(screen: str) -> str:
    lines = _ANSI_ESCAPE.sub("", screen).replace("\r", "").splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines[-12:])


def _matching_screen_lines(screen: str) -> list[str]:
    lines = []
    for line in _visible_screen_tail(screen).splitlines():
        line = line.strip()
        if line.startswith(("│", "|")):
            line = line[1:].lstrip()
        if line.endswith(("│", "|")):
            line = line[:-1].rstrip()
        if line:
            lines.append(line)
    return lines


def is_interactive_prompt(screen: str) -> bool:
    lines = _matching_screen_lines(screen)
    if not lines:
        return False

    if _PROMPT_LINE.search(lines[-1]):
        return True

    if _has_active_prompt_footer(lines):
        return True

    for index, line in enumerate(lines):
        if not _PROMPT_QUESTION.search(line):
            continue
        following = lines[index + 1:]
        if not any(_PROMPT_OPTION.search(option) for option in following[:5]):
            continue
        footer_index = next(
            (offset for offset, option in enumerate(following)
             if _PROMPT_FOOTER.search(option)),
            None,
        )
        if footer_index is not None:
            trailing = following[footer_index + 1:]
            if any(
                not option.lstrip().startswith(("╰", "╯", "└", "┘", "+"))
                for option in trailing
            ):
                # A completed menu in retained scrollback may be followed by the
                # agent's answer. It is historical once substantive text follows its
                # footer, even if the menu itself remains visible.
                continue
        return True
    return False


def _has_active_prompt_footer(lines: list[str]) -> bool:
    footer_index = next(
        (index for index in range(len(lines) - 1, -1, -1)
         if _PROMPT_FOOTER.search(lines[index])),
        None,
    )
    if footer_index is not None and footer_index >= len(lines) - 3:
        following = lines[footer_index + 1:]
        return not following or all(
            line.lstrip().startswith(("╰", "╯", "└", "┘", "+"))
            for line in following
        )
    return False


def is_interactive_busy(screen: str) -> bool:
    lines = _matching_screen_lines(screen)
    return bool(lines and _BUSY_STATUS.fullmatch(lines[-1]))


def emit_event(event: StreamEvent) -> None:
    event_data = {
        key: value
        for key, value in asdict(event).items()
        if value is not None
    }
    emit({
        "kind": "event",
        "event": event_data,
    })

def emit(message: dict[str, object]) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()

def emit_warning(message: Warning, *_args: object, **_kwargs: object) -> None:
    emit({
        "kind": "warning",
        "message": str(message),
    })

def require_string(request: dict[str, object], key:str) -> str:
    value = request.get(key)

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")

    return value

def optional_string(request: dict[str, object], key:str) -> str | None:
    value = request.get(key)

    if value is None:
        return None

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string when provided")

    return value

def optional_string_list(request: dict[str, object], key:str) -> list[str] | None:
    value = request.get(key)

    if value is None:
        return None

    if not isinstance(value, list) or not value:
        raise ValueError(f"{key} must be a non-empty list when provided")

    if not all(isinstance(item,str) and item.strip() for item in value):
        raise ValueError(f"{key} must contain only non-empty strings")

    return value

async def run() -> int:
    try:
        return await main()
    except Exception as error:
        emit({
            "kind": "fatal",
            "message": str(error),
        })
        return 1

if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
