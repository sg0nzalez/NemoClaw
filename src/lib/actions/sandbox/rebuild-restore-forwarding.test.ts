// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sandboxState from "../../state/sandbox";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("rebuild restore target forwarding", () => {
  it("forwards the recreated target identity and explicit custom-image capability", async () => {
    const backupPath = fs.mkdtempSync(path.join(process.cwd(), ".nemoclaw-rebuild-restore-"));
    fs.chmodSync(backupPath, 0o700);
    fixtures.push(backupPath);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restoreRecreatedSandboxState = vi
      .spyOn(sandboxState, "restoreRecreatedSandboxState")
      .mockResolvedValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    await runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "langchain-deepagents-code",
      targetImageIsCustom: true,
      backupManifest: { agentType: "openclaw", backupPath } as never,
      policyPresets: [],
      customPolicies: [],
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
      allowCustomImageWholeStateFileRestore: true,
    });
  });
});
