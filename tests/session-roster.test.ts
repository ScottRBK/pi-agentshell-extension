import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { loadAgentShellConfig } from "../config.ts";

const reviewer = {
  name: "reviewer", description: "Review code", agent_type: "pi", model: "test", effort: "high",
};

test("a session file replaces only the roster without changing home or environment", () => {
  // Arrange
  const root = mkdtempSync(join(tmpdir(), "agentshell-session-roster-"));
  const original = process.env.PI_AGENTSHELL_ROSTER_FILE;
  try {
    mkdirSync(join(root, "extensions"));
    const globalPath = join(root, "extensions/agentshell.json");
    const globalText = JSON.stringify({ max_output_bytes: 1234, silent: true,
      max_sub_agent_depth: 2, roster: { enabled: false, roles: [] } });
    writeFileSync(globalPath, globalText);
    const selected = join(root, "roster.json");
    writeFileSync(selected, JSON.stringify({ roster: { enabled: true, roles: [reviewer] } }));
    process.env.PI_AGENTSHELL_ROSTER_FILE = relative(process.cwd(), selected);
    const environment = { ...process.env };

    // Act
    const config = loadAgentShellConfig(root);

    // Assert
    assert.deepEqual(config.roster, { enabled: true, roles: [reviewer] });
    assert.equal(config.max_output_bytes, 1234);
    assert.equal(config.silent, true);
    assert.equal(config.max_sub_agent_depth, 2);
    assert.equal(readFileSync(globalPath, "utf8"), globalText);
    assert.deepEqual({ ...process.env }, environment);
  } finally {
    if (original === undefined) delete process.env.PI_AGENTSHELL_ROSTER_FILE;
    else process.env.PI_AGENTSHELL_ROSTER_FILE = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid explicit rosters fail closed rather than using the personal roster", () => {
  // Arrange
  const root = mkdtempSync(join(tmpdir(), "agentshell-invalid-roster-"));
  const original = process.env.PI_AGENTSHELL_ROSTER_FILE;
  try {
    const path = join(root, "selected.json");
    const cases = [
      [undefined, /selected.json/],
      ["{", /valid JSON/],
      ["[]", /JSON object/],
      ["{}", /roster/],
      ['{"roster":{},"max_sub_agent_depth":99}', /only.*roster/],
      [JSON.stringify({ roster: { roles: [reviewer, reviewer] } }), /duplicate/],
      [JSON.stringify({ roster: { enabled: "true" } }), /boolean/],
    ] as const;
    for (const [contents, error] of cases) {
      if (contents !== undefined) writeFileSync(path, contents);
      process.env.PI_AGENTSHELL_ROSTER_FILE = path;
      // Act / Assert
      assert.throws(() => loadAgentShellConfig(root, 1), error);
    }
    process.env.PI_AGENTSHELL_ROSTER_FILE = "";
    assert.throws(() => loadAgentShellConfig(root), /non-empty path/);
  } finally {
    if (original === undefined) delete process.env.PI_AGENTSHELL_ROSTER_FILE;
    else process.env.PI_AGENTSHELL_ROSTER_FILE = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("roster-owned resources, cwd and child roster paths are relative to their file", () => {
  // Arrange
  const root = mkdtempSync(join(tmpdir(), "agentshell-relative-roster-"));
  const original = process.env.PI_AGENTSHELL_ROSTER_FILE;
  try {
    mkdirSync(join(root, "role"));
    mkdirSync(join(root, "role/work"));
    writeFileSync(join(root, "role/skill.md"), "# A local skill");
    writeFileSync(join(root, "role/extension.ts"), "export default function () {}");
    writeFileSync(join(root, "role/children.json"), '{"roster":{"enabled":false}}');
    const path = join(root, "role/roster.json");
    writeFileSync(path, JSON.stringify({ roster: { enabled: true, roles: [{ ...reviewer,
      cwd: "./work", roster_file: "./children.json", resources: {
        skills: ["./skill.md"], extensions: ["./extension.ts"], mcp_servers: [],
        inherit_personal_resources: false, inherit_project_resources: false,
        include_home_system_prompt: false,
      },
    }] } }));
    process.env.PI_AGENTSHELL_ROSTER_FILE = path;

    // Act
    const role = loadAgentShellConfig(root).roster.roles[0];

    // Assert
    assert.equal(role.cwd, join(root, "role/work"));
    assert.equal(role.roster_file, join(root, "role/children.json"));
    assert.deepEqual(role.resources?.skills, [join(root, "role/skill.md")]);
    assert.deepEqual(role.resources?.extensions, [join(root, "role/extension.ts")]);
    assert.deepEqual(role.resources?.mcp_servers, []);
    assert.equal(role.resources?.include_instruction_files, true);
  } finally {
    if (original === undefined) delete process.env.PI_AGENTSHELL_ROSTER_FILE;
    else process.env.PI_AGENTSHELL_ROSTER_FILE = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("child roster_file is Pi-only; mixed rosters keep non-Pi generic resources", () => {
  // Arrange
  const root = mkdtempSync(join(tmpdir(), "agentshell-pi-only-roster-"));
  const original = process.env.PI_AGENTSHELL_ROSTER_FILE;
  try {
    const path = join(root, "selected.json");
    const child = join(root, "child.json");
    writeFileSync(child, '{"roster":{"enabled":false}}');
    writeFileSync(join(root, "skill.md"), "# Skill");
    process.env.PI_AGENTSHELL_ROSTER_FILE = path;
    const codex = { ...reviewer, name: "codex-reviewer", agent_type: "codex",
      resources: { skills: ["skill.md"] } };
    writeFileSync(path, JSON.stringify({ roster: { enabled: true, roles: [reviewer, codex] } }));
    // Act / Assert
    const config = loadAgentShellConfig(root);
    assert.equal(config.roster.roles[1].agent_type, "codex");
    assert.deepEqual(config.roster.roles[1].resources?.skills, [join(root, "skill.md")]);
    for (const enabled of [true, false]) {
      writeFileSync(path, JSON.stringify({ roster: { enabled,
        roles: [reviewer, { ...codex, roster_file: child }] } }));
      assert.throws(() => loadAgentShellConfig(root), /roster_file.*only.*pi/i);
    }
  } finally {
    if (original === undefined) delete process.env.PI_AGENTSHELL_ROSTER_FILE;
    else process.env.PI_AGENTSHELL_ROSTER_FILE = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid entry paths and resource settings are rejected in either roster location", () => {
  // Arrange
  const root = mkdtempSync(join(tmpdir(), "agentshell-entry-validation-"));
  const original = process.env.PI_AGENTSHELL_ROSTER_FILE;
  try {
    mkdirSync(join(root, "extensions"));
    const globalPath = join(root, "extensions/agentshell.json");
    const selectedPath = join(root, "selected.json");
    for (const location of [globalPath, selectedPath]) {
      for (const extra of [
        { cwd: "missing" }, { roster_file: "missing.json" }, { roster_file: root },
        { resources: null }, { resources: { skills: ["missing.md"] } },
        { resources: { extensions: ["npm:never-install@1.0.0"] } },
        { resources: { packages: ["remote"] } },
        { resources: { inherit_project_resources: "false" } },
        { resources: { unknown: [] } },
      ]) {
        writeFileSync(globalPath, "{}");
        writeFileSync(location, JSON.stringify({ roster: {
          enabled: false, roles: [{ ...reviewer, ...extra }],
        } }));
        if (location === globalPath) delete process.env.PI_AGENTSHELL_ROSTER_FILE;
        else process.env.PI_AGENTSHELL_ROSTER_FILE = location;
        // Act / Assert
        assert.throws(() => loadAgentShellConfig(root), (error: Error) => {
          assert.match(error.message, /path|resources/i);
          assert.ok(error.message.includes(location), error.message);
          assert.match(error.message, /roster\.roles\[0\]/);
          return true;
        });
      }
    }
  } finally {
    if (original === undefined) delete process.env.PI_AGENTSHELL_ROSTER_FILE;
    else process.env.PI_AGENTSHELL_ROSTER_FILE = original;
    rmSync(root, { recursive: true, force: true });
  }
});
