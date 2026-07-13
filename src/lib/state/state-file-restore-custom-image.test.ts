// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxControl } from "../adapters/openshell/sandbox-control";
import type { StateFileKeyAllowlistRestoreOwnership } from "../agent/defs";
import { restoreStateFile } from "./state-file-restore";

const execMock = vi.fn<OpenShellSandboxControl["exec"]>(async () => ({
  status: 0,
  stdout: "",
  stderr: "",
}));
const sandboxControl = { exec: execMock };

const fixtures: string[] = [];
const ownership: StateFileKeyAllowlistRestoreOwnership = {
  merge: "key-allowlist",
  userKeys: [{ key: "ui.show_scrollbar", type: "boolean" }],
  requireFreshTables: ["models"],
};

function createBackupFixture(): { backupPath: string; backupContents: Buffer } {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-state-"));
  fixtures.push(backupPath);
  const backupContents = Buffer.from(
    '[models]\ndefault = "backup-owned"\n\n[ui]\nshow_scrollbar = true\n',
  );
  fs.writeFileSync(path.join(backupPath, "config.toml"), backupContents);
  return { backupPath, backupContents };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("custom-image state-file restore capability (#6334)", () => {
  it("restores the complete backup without invoking the managed key allowlist", async () => {
    const { backupPath, backupContents } = createBackupFixture();

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      true,
      vi.fn(),
    );

    expect(restored).toBe(true);
    const request = execMock.mock.calls[0]?.[0];
    const command = String(request?.command.at(-1));
    expect(command).toContain(".nemoclaw-restore.XXXXXX");
    expect(command).not.toContain("/opt/venv/bin/python3");
    expect(command).not.toContain("show_scrollbar");
    expect(request?.stdin).toEqual(backupContents);
  });

  it("requires the capability before bypassing the managed key allowlist", async () => {
    const { backupPath, backupContents } = createBackupFixture();

    const restored = await restoreStateFile(
      sandboxControl,
      "alpha",
      "/sandbox/.deepagents",
      { path: "config.toml", strategy: "copy" },
      backupPath,
      ownership,
      false,
      vi.fn(),
    );

    expect(restored).toBe(true);
    const request = execMock.mock.calls[0]?.[0];
    const command = String(request?.command.at(-1));
    expect(command).toContain("/opt/venv/bin/python3 -I -c");
    expect(command).toContain("show_scrollbar");
    expect(command).toContain("require_fresh_tables");
    expect(command).not.toContain(".nemoclaw-restore.XXXXXX");
    expect(request?.stdin).toEqual(backupContents);
  });
});
