# Session-specific child rosters

## Launch and file shape

`PI_AGENTSHELL_ROSTER_FILE` selects only the roster. It does not select a new Pi home, login,
settings file, system prompt, or delegation policy. For example, an external launcher can run:

```bash
PI_AGENTSHELL_ROSTER_FILE=/workspace/.factory/agents/foreman/roster.json pi
```

No Factory integration is implemented by this extension. Names below are ordinary entry names,
not built-in roles. This example file describes the child the foreman session may launch:

```json
{
  "roster": {
    "enabled": true,
    "roles": [
      {
        "name": "feature-owner",
        "description": "Own a feature and delegate implementation and review",
        "agent_type": "pi",
        "model": "provider/model-selector",
        "effort": "high",
        "cwd": "../feature-owner",
        "roster_file": "../feature-owner/roster.json",
        "resources": {
          "skills": ["../../skills/ownership/SKILL.md"],
          "extensions": ["../../extensions/agentshell.ts"],
          "plugins": [],
          "packages": [],
          "mcp_servers": [],
          "inherit_personal_resources": false,
          "inherit_project_resources": false,
          "include_instruction_files": true,
          "include_home_system_prompt": false
        }
      }
    ]
  }
}
```

All referenced files/directories must already exist. Replace the illustrative model selector with
one supported by the native harness. The child's `roster.json` uses the same shape and can contain
entries such as `implementation` and `reviewer`. It describes that child's children, not its own
resources. A roster can refer back to another roster; files are not recursively expanded at load.

The selected file must contain exactly the top-level `roster` key. Unknown settings, duplicate
names, malformed JSON, invalid resource values, and missing paths are errors, not fallback requests.
Referenced paths and entries are checked even when `enabled` is `false`; disabling a roster does
not skip validation of explicitly supplied configuration. Errors identify the source file and entry.
The roster's `enabled` defaults to `false` and `roles` defaults to `[]`, as in personal
configuration.
Every entry requires nonempty `name`, `description`, `agent_type`, `model`, and `effort` strings.
Names are case-sensitive. `cwd`, `resources`, and `roster_file` are optional.
`roster_file` is Pi-only; using it with another `agent_type` is an error, including on ad-hoc calls.
Mixed-harness rosters without that Pi-only field remain supported.

Without the environment override, the roster continues to come from
`<Pi agent directory>/extensions/agentshell.json`. That file also owns limits, silent mode,
interactive defaults, and the root's `MAX_SUB_AGENT_DEPTH`. A selected roster cannot change them.

## Calling the existing tool

```text
subagent({
  roster_entry: "feature-owner",
  task_name: "Add export support",
  prompt: "Implement export support and arrange a review."
})
```

`subagent_roster` lists the effective entries, including resolved resource paths. The named call
applies the entry's harness, model, effort, optional cwd, resources, and child roster automatically.
Manual repeats of those settings must agree; conflicts and unknown/disabled entries fail before
a worker or background job is started. If an entry omits cwd, the caller may choose it.
Approval/tool controls and interactive options remain ordinary tool arguments.

Existing explicit calls remain valid. Ad-hoc calls can also select local resources and a child
roster directly:

```text
subagent({
  agent_type: "pi",
  task_name: "Inspect changes",
  prompt: "Inspect the current changes.",
  cwd: "/workspace/project",
  resources: {
    skills: ["./skills/review/SKILL.md"],
    mcp_servers: [],
    inherit_personal_resources: false,
    inherit_project_resources: false
  },
  roster_file: "./agents/reviewer/roster.json"
})
```

Use `interactive: true` for the native tmux UI. The same resources reach AgentShell's public
`SessionResources` through both `stream` and `open_interactive`. Unsupported resource combinations
raise before the native agent starts. In background mode, worker validation errors arrive as job
failures; they do not mean an agent ran with weaker exclusions.

## Paths and child environments

- An absolute environment override is recommended. A relative override resolves against the parent
  process cwd when the extension loads.
- Paths inside a roster (`cwd`, `roster_file`, skills, plugins, extensions) resolve against that
  roster file's directory, **not** the child's cwd. This also applies to the personal configuration
  file: its base directory is `<Pi agent directory>/extensions`.
- Ad-hoc `cwd` resolves against the tool context cwd. Ad-hoc resources and `roster_file` resolve
  against the effective child cwd. Paths become absolute; symlink identities are not canonicalized.
- JSON paths do not expand `~`, environment variables, package selectors, or URLs. Supply already
  provisioned local files/directories. A symlinked roster uses the selected pathname's directory.
- The child's selected `roster_file` is set only in its worker/native process environment. The
  parent environment and personal files are not modified. Concurrent children get separate values.
- If no child override is selected, `PI_AGENTSHELL_ROSTER_FILE` is removed from the child
  environment.
  The child then uses ordinary default-roster behavior; it does not inherit the parent's override.
  To explicitly disable its roster, select a file containing `{"roster":{"enabled":false}}`.
- Child roster content is validated when launching that child. This does not recursively validate
  all descendants. Invalid selections never fall back to the personal roster.

`/agentshell-roster` retains its global-persistence behavior only when no override is selected.
With an explicit file it is an in-memory toggle; `/reload` restores the file's `enabled` value.
Roster entries are snapshots at extension load. Reload after editing entries. An explicitly
selected child roster is checked again at launch and resume.

The inherited maximum delegation depth still applies before extension startup, regardless of the
child's roster or harness. Local configuration cannot reset it. With discovery excluded, explicitly
include this extension in a child's `extensions` if that child should delegate, and configure an
adequate depth at the root. Neither setting restricts native Bash or manual CLI launches.

## Resource choices and limits

The worker pins AgentShell 0.5.0; see the [supply-chain audit](agentshell-0.5-audit.md).
Existing installations must update the extension's own worker, not an outer launcher's environment.
Follow the setup command reported by the extension, then reload Pi. It uses
`uv sync --project "<extension>/python" --locked --no-build` to install the audited wheel, not build
an sdist. Updates require your consent; selecting resources never triggers an automatic install.
No resources are silently ignored on an older runtime; ordinary calls without resources remain
compatible.

`resources` is optional. Its fields follow AgentShell's harness-neutral concepts:

- `skills`, `plugins`, `extensions`: local path arrays, default `[]`. Native formats and support
  depend on the harness. For Pi, use skills/extensions; plugins are unsupported.
- `packages`: omit or `[]` only. Nonempty selections are rejected; this extension never runs a
  resource-package installer. Provision files separately after your own supply-chain review.
- `mcp_servers`: omit or `null` to inherit; `[]` to disable. Nonempty native MCP selections are not
  exposed here, including for Pi.
- `inherit_personal_resources`, `inherit_project_resources`: booleans, both default `true`.
- `include_instruction_files`, `include_home_system_prompt`: booleans, both default `true`.

Pi can exclude personal and project discovery only together. Set both inheritance flags to `false`
and supply `mcp_servers: []` to exclude them. Explicit local skills/extensions are still selected.
This uses Pi's exclusion/offline flags, without installing packages or replacing its home.
With inheritance enabled, ordinary native discovery/settings behavior remains in effect.

`include_home_system_prompt: false` excludes home `SYSTEM.md` while ordinary native AGENTS/append
instruction handling remains available when `include_instruction_files` is true. AgentShell 0.5
rejects interactive home-prompt exclusion when cwd contains `.pi/SYSTEM.md`, rather than silently
changing project-prompt behavior. Other unsupported combinations also fail before native launch.

Native role-root `AGENTS.md` can load when cwd is that role directory. A root `APPEND_SYSTEM.md`
is not automatically discovered. This extension adds no custom prompt machinery. Native Pi Bash
already supplies `PI_SESSION_ID`; callers must not mistake an unrelated inherited environment
variable for a child's role identity.

Selected extension code runs with the user's permissions. Shared Pi settings, instructions,
authentication, environment, and filesystem access are **not a security sandbox**. No auth,
credential copying, provider isolation, or replacement Pi launcher is implemented here.

## Resumption

A successful native session ID is remembered with its effective launch configuration in custom
entries on the parent Pi session branch. This includes the roster source/entry, cwd, model/effort,
approval/tool controls, interactive settings, resource selection, and explicit child roster
contents.
Approval/tool controls in these records describe the previous call; they are never restored.
Startup/reload rebuilds launch knowledge from the current parent branch. During tree navigation,
the running extension adds records from the visited branch without forgetting launches it already
knows. Leaving a branch cannot turn a known selected session into an unrestricted ad-hoc session.
This protection is in memory for that runtime, not a new global registry or recovery store.

```text
subagent({
  task_name: "Continue export support",
  prompt: "Address the review findings.",
  resume_session_id: "<native ID returned by the earlier successful result>"
})
```

For a known selected ID, omitted selection and interactive settings reuse the saved launch, even if
the parent's current cwd or global interactive defaults differ. You need not repeat `roster_entry`
or resources. Approval and tool controls are never restored.

- A roster-selected session keeps its harness, cwd, resources, roster source/entry, child roster,
  and roster-defined model/effort. Omitting `roster_entry` does not remove that contract. A changed
  entry or child roster content is rejected. If its roster is now disabled, re-enable it first.
- Ad-hoc sessions with explicit resources or a child roster keep their harness, cwd and resource/
  child-roster selection. Their model and effort may change on resume.
- Ordinary ad-hoc sessions without those selections retain explicit-argument resume behavior,
  including model/effort changes. Existing plain snapshots are convenience defaults, not role locks.
- `auto_approve`, `allowed_tools` and `disallowed_tools` apply only to the current call, including
  resumes. Omitted `auto_approve` is false; omitted tool lists mean no explicit list for this call.
  Previous approval/tool choices are never inherited, including from older saved launch records.
- Interactive/inactivity options still reuse saved defaults when omitted; explicit values override
  them. Native capability checks and the retained-process guard below still apply. Resource
  exclusions are not weakened by these overrides.

Conflicts identify the differing fields. Start a new session for a different selected role or
resource selection. No saved configuration bypasses the current inherited delegation-depth policy.

Limits of this guarantee:

- Initial/reload restoration reads only the current parent Pi branch. Within-runtime knowledge
  from other branches does not survive a reload unless the current branch has the needed record.
  An unrelated parent also cannot recover it. Resume selected IDs from their owning parent/branch.
  Unknown legacy/ad-hoc IDs still accept ordinary explicit calls for compatibility; the extension
  cannot prove their original settings. Adding roster/resources to an unrecorded resume is rejected.
- AgentShell additionally stores resource-selection digests in its normal state directory
  (`XDG_STATE_HOME`, or `~/.local/state`). They check selected paths/options and cwd, not file
  contents.
  Editing a skill/extension at the same path is not detected or frozen. Nor are inherited native
  configuration, credentials, symlink targets, or the entire descendant roster graph frozen.
  Checks occur at call time, not through atomic file snapshots; edits after validation can still
  affect what the native child loads.
- A Job ID is not a native session ID. Job status/activity remains memory-only. Only successful
  returned native IDs receive these configuration records; there is no durable job/recovery system.
- Do not resume an active session, including one already being resumed. Concurrent resumes of
  the same native ID are not prevented. This is not a liveness or recovery system.
- A result from a `stay_open` interactive run does not prove the process stopped. This extension
  conservatively blocks resuming its retained result until the owning Pi session is shut down or
  reloaded and its workers cleaned up. Unclean crashes and external native processes are not
  tracked.
- Native conversations, availability of IDs, and actual continuation remain the harness's job.
  Interactive Codex's existing terminal-capture limitation still applies.

## External launchers and validation

A future Factory integration must provision these local files, supply the launch environment
variable, choose cwd, and retain the returned native ID with its owning parent-session context.
It must arrange native authentication separately and respect the inherited depth limit. No Factory
code or AgentShell library changes are required or included here.

Regression tests use the existing public config loaders, registered Pi tools, and worker JSON-line
boundary. Only native processes are doubled; real AgentShell translates resources in headless and
isolated-tmux paths. Temporary homes/state and owned sockets avoid personal configuration. These
checks make no model calls and do not establish live authentication or crash-recovery guarantees.
