// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";

import { KEY_ALLOWLIST_MERGE_PYTHON } from "./state-file-key-merge";
import {
  DCODE_OWNERSHIP,
  generatedCurrent,
  IN_PLACE_MUTATION_SCRIPT,
  INODE_SWAP_MARKER,
  INODE_SWAP_SCRIPT,
  mergedToml,
  runMergeScript,
  runProductionCommand,
  stageSwapScript,
} from "./state-file-key-merge-test-fixture";

describe("key-allowlist state-file merge", () => {
  it("executes the fixed merge program with a staged payload and digest", () => {
    const backup = stringify({ ui: { show_scrollbar: true } });
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const result = runProductionCommand(backup, current);

    expect(result.status).toBe(0);
    expect(mergedToml(result.current)).toEqual({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
      ui: { show_scrollbar: true },
    });
    expect(result.command).not.toContain("backup_tmp");
    expect(result.command).not.toContain("staged_tmp");
    expect(result.command).not.toContain('cat > "$backup_tmp"');
    expect(result.entries.some((entry) => entry.startsWith(".nemoclaw-restore-merged."))).toBe(
      false,
    );
  });

  it("rejects symlinked and hard-linked current configs through the production command", () => {
    const backup = stringify({ ui: { show_scrollbar: true } });
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    for (const currentLink of ["symlink", "hardlink"] as const) {
      const result = runProductionCommand(backup, current, { currentLink });

      expect(result.status, currentLink).not.toBe(0);
      expect(result.current, currentLink).toBe(current);
      expect(result.currentTarget, currentLink).toBe(current);
    }
  });

  it("rejects a symlink in a config parent ancestor through the production command", () => {
    const backup = stringify({ ui: { show_scrollbar: true } });
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const result = runProductionCommand(backup, current, { parentAncestorSymlink: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("config parent directory is unsafe");
    expect(result.current).toBe(current);
  });

  it.each([
    ["group-writable stage", { stagedMode: 0o620 }],
    ["digest mismatch", { stagedDigest: "0".repeat(64) }],
  ])("rejects a %s before changing the current config", (_label, options) => {
    const backup = stringify({ ui: { show_scrollbar: true } });
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const result = runProductionCommand(backup, current, options);

    expect(result.status).not.toBe(0);
    expect(result.current).toBe(current);
  });

  it("rejects symlink, hardlink, and inode swaps of its private stage before replacement", () => {
    const backup = stringify({ ui: { show_scrollbar: true } });
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    for (const kind of ["symlink", "hardlink", "regular"] as const) {
      const result = runProductionCommand(backup, current, { script: stageSwapScript(kind) });

      expect(result.status, kind).not.toBe(0);
      expect(result.stderr, kind).toContain("config staging file changed before atomic restore");
      expect(result.current, kind).toBe(current);
      expect(result.attackTarget, kind).toBe("stage attack target must remain unchanged\n");
      expect(
        result.entries.some((entry) => entry.startsWith(".nemoclaw-restore-merged.")),
        kind,
      ).toBe(true);
    }
  });

  it("refuses to replace a current config whose inode changes after validation", () => {
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const result = runMergeScript(
      stringify({ ui: { show_scrollbar: true } }),
      current,
      DCODE_OWNERSHIP,
      { script: INODE_SWAP_SCRIPT },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("current config changed before atomic restore");
    expect(result.current).toBe(INODE_SWAP_MARKER);
    expect(result.swappedOriginal).toBe(current);
    expect(result.stageEntries).toEqual([]);
  });

  it("refuses to replace a current config modified in place after validation", () => {
    const current = generatedCurrent({
      models: { default: "openai:nvidia/new-model" },
      update: { check: false, auto_update: false },
    });

    const result = runMergeScript(
      stringify({ ui: { show_scrollbar: true } }),
      current,
      DCODE_OWNERSHIP,
      { script: IN_PLACE_MUTATION_SCRIPT },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("current config changed before atomic restore");
    expect(result.current).toBe(`${current}# concurrent mutation\n`);
    expect(result.stageEntries).toEqual([]);
  });

  it("keeps the atomic replacement primitive in the fixed merge program", () => {
    expect(KEY_ALLOWLIST_MERGE_PYTHON).toContain(
      "os.replace(staged_name, current_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)",
    );
  });
});
