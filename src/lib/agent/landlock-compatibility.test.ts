// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENTS_DIR, loadAgent } from "./defs";

const tempAgentDirs: string[] = [];

function writeTempAgentManifest(name: string, contents: string): void {
  const agentDir = path.join(AGENTS_DIR, name);
  tempAgentDirs.push(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "manifest.yaml"), contents);
}

afterEach(() => {
  while (tempAgentDirs.length > 0) {
    const agentDir = tempAgentDirs.pop();
    if (agentDir) {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }
});

describe("agent Landlock compatibility", () => {
  it("loads the intended compatibility for each supported agent (#5795)", () => {
    expect(loadAgent("openclaw").landlockCompatibility).toBe("best_effort");
    expect(loadAgent("hermes").landlockCompatibility).toBe("best_effort");
    expect(loadAgent("langchain-deepagents-code").landlockCompatibility).toBe("hard_requirement");
  });

  it("rejects legacy strict compatibility in manifests (#5795)", () => {
    const agentName = `invalid-landlock-compatibility-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Broken Landlock Compatibility",
        "landlockCompatibility: strict",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(
      /landlockCompatibility.*best_effort or hard_requirement/,
    );
  });
});
