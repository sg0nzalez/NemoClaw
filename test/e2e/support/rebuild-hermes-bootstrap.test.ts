// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LIVE_TEST_PATH = path.join(REPO_ROOT, "test/e2e/live/rebuild-hermes.test.ts");

describe("rebuild Hermes bootstrap boundary", () => {
  it("uses the current source CLI and pinned OpenShell without onboarding a throwaway sandbox", () => {
    const source = fs.readFileSync(LIVE_TEST_PATH, "utf8");

    expect(source).toContain('host.command("node", [CLI_ENTRYPOINT, "--help"]');
    expect(source).toContain('["gateway", "start", "--name", "nemoclaw"]');
    expect(source).toContain('[CLI_ENTRYPOINT, SANDBOX_NAME, "rebuild", "--yes", "--verbose"]');
    expect(source).not.toContain('host.command("bash", ["install.sh", "--non-interactive"]');
    expect(source).not.toContain("phase-1-delete-current-sandbox");
    expect(source).not.toContain("phase-1-remove-initial-hermes-image");
  });
});
