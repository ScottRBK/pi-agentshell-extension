import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function packageHarness(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const subagent = pi
      .getAllTools()
      .find((tool) => tool.name === "subagent");

    assert.ok(subagent, "installed package did not register the subagent tool");
    assert.match(
      JSON.stringify(subagent.sourceInfo),
      /extensions[\\/]agentshell\.ts/,
      "package did not load its conventional extension entry point",
    );
    process.stderr.write("PACKAGE_HARNESS_OK\n");
  });
}
