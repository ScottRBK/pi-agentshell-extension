# AgentShell worker 0.5.0 audit

Scope: this extension's independent Python worker, upgrading `agent-shell-py` 0.4.0 to 0.5.0.
The review happened before changing its manifest/lock or installing the new wheel.

## Evidence

The existing Factory review at
`/home/scott/development/ai/forgetful-factory/docs/plans/agentshell-0.5-audit.md`
covered the same upstream artifact. Its original approval did not upgrade this worker.
For this worker, we independently downloaded the wheel and sdist from official PyPI, verified both
hashes against that review and PyPI metadata, checked every wheel RECORD hash, and compared the
wheel's Python source with the official release checkout (apart from generated `_version.py`).

- Official tag `v0.5.0`: `b1e0587dcfd6065a1fe1d3057626e7a912547847`.
- Python >=3.12; no transitive runtime dependencies.
- No wheel entry-point installation scripts, `.pth`, or Python startup hooks.
- OSV's direct-package 0.5.0 query returned no advisories during this review. This is not proof of
  absence of vulnerabilities.
- The earlier audit checked publish attestations but did not perform full Sigstore policy
  verification. This worker review does not claim additional signature verification.

SHA-256:

```text
agent_shell_py-0.5.0-py3-none-any.whl
57b0b8b8aa87ab165f1bcf301c2da447e3bae97afd9a69ed074a75ffcff59f43
agent_shell_py-0.5.0.tar.gz
987cdc093587c80c2304efd6735485c79538de190664a54caa25b29fa1bb717e
```

## Decision and constraints

Use the pinned wheel in this repository's worker environment; do not build the sdist. No global
installation or host-tool upgrade is approved. Keep the existing user-consent setup flow.
The extension accepts provisioned local resource paths only, rejects nonempty `packages`, and
supports MCP inheritance or `mcp_servers: []` (disabled), not native MCP server configuration.

The reviewed 0.5.0 public `SessionResources` works with `stream` and `open_interactive`.
AgentShell rejects unsupported exclusions before launching the native CLI. Pi requires matching
personal/project inheritance flags and MCP disabled when both are excluded. Selected extensions
execute code with the user's permissions. Selection/digest checks identify paths and options;
they do not freeze file contents, isolate credentials, or provide a security sandbox.

## Sources

- <https://pypi.org/pypi/agent-shell-py/0.5.0/json>
- <https://github.com/ScottRBK/agent-shell/releases/tag/v0.5.0>
- <https://github.com/ScottRBK/agent-shell/blob/v0.5.0/src/agent_shell/models/resources.py>
- <https://github.com/ScottRBK/agent-shell/blob/v0.5.0/src/agent_shell/adapters/pi_adapter.py>
