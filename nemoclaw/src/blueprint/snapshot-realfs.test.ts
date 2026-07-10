// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

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
  it.skipIf(process.platform === "win32")(
    "rejects a symlinked snapshot delete path without touching the outside target",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-home-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-outside-"));
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
