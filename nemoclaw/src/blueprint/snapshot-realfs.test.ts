// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];
const REAL_TMP = fs.realpathSync(os.tmpdir());

async function loadSnapshotModule(home: string): Promise<typeof import("./snapshot.js")> {
  vi.resetModules();
  vi.doMock("node:os", () => ({
    homedir: () => home,
  }));
  return import("./snapshot.js");
}

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("snapshot real filesystem safety", () => {
  function writeSnapshot(snapshotsDir: string, timestamp: string): string {
    const snapshotDir = path.join(snapshotsDir, timestamp);
    fs.mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "openclaw", "config.json"), "{}\n");
    fs.writeFileSync(
      path.join(snapshotDir, "snapshot.json"),
      JSON.stringify(
        {
          timestamp,
          source: path.join(os.tmpdir(), "openclaw-source"),
          file_count: 1,
          contents: ["config.json"],
        },
        null,
        2,
      ),
    );
    return snapshotDir;
  }

  it.skipIf(process.platform === "win32")(
    "deletes a normal direct-child timestamp snapshot",
    async () => {
      const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
      tempRoots.push(home);

      const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
      const snapshotDir = writeSnapshot(snapshotsDir, "20990101T000000Z");
      const { deleteSnapshot } = await loadSnapshotModule(home);

      expect(deleteSnapshot(snapshotDir)).toBe(true);
      expect(fs.existsSync(snapshotDir)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")("prunes older direct-child snapshots", async () => {
    const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
    tempRoots.push(home);

    const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
    const older = writeSnapshot(snapshotsDir, "20990101T000000Z");
    const newer = writeSnapshot(snapshotsDir, "20990201T000000Z");
    const { pruneSnapshots } = await loadSnapshotModule(home);

    const result = pruneSnapshots(1);

    expect(result.deleted).toEqual([older]);
    expect(result.kept).toEqual([newer]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked snapshot delete path without touching the outside target",
    async () => {
      const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
      const outside = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-outside-"));
      tempRoots.push(home, outside);

      const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
      const outsideFile = path.join(outside, "keep.txt");
      const symlinkedSnapshot = path.join(snapshotsDir, "20990101T000000Z");
      fs.mkdirSync(snapshotsDir, { recursive: true });
      fs.writeFileSync(outsideFile, "outside target must survive");
      fs.symlinkSync(outside, symlinkedSnapshot, "dir");

      const { deleteSnapshot } = await loadSnapshotModule(home);

      expect(deleteSnapshot(symlinkedSnapshot)).toBe(false);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside target must survive");
      expect(fs.lstatSync(symlinkedSnapshot).isSymbolicLink()).toBe(true);
    },
  );
});
