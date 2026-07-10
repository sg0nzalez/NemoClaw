// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type fs from "node:fs";
const SNAP = "/snap/20260323";

// ── In-memory filesystem ────────────────────────────────────────

interface FsEntry {
  type: "file" | "dir" | "symlink";
  content?: string;
  target?: string;
}

const store = new Map<string, FsEntry>();
const rmFailures = new Set<string>();
let snapshotDeleteHelperFails = false;

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

function addSymlink(p: string, target: string): void {
  store.set(p, { type: "symlink", target });
}

const FAKE_HOME = "/fakehome";
const MOCK_SNAPSHOTS_DIR = `${FAKE_HOME}/.nemoclaw/snapshots`;

function mapMockPath(p: string): string {
  return p;
}

function throwFsError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(mapMockPath(p)),
    lstatSync: (p: string) => {
      p = mapMockPath(p);
      const entry = store.get(p);
      if (!entry) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${p}'`), {
          code: "ENOENT",
        });
      }
      return {
        isSymbolicLink: () => entry.type === "symlink",
        isDirectory: () => entry.type === "dir",
        isFile: () => entry.type === "file",
      };
    },
    readlinkSync: (p: string) => {
      p = mapMockPath(p);
      const entry = store.get(p);
      if (entry?.type !== "symlink") {
        throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${p}'`), {
          code: "EINVAL",
        });
      }
      return entry.target ?? "";
    },
    mkdirSync: vi.fn((p: string) => {
      p = mapMockPath(p);
      addDir(p);
    }),
    readFileSync: (p: string) => {
      p = mapMockPath(p);
      const entry = store.get(p);
      if (entry?.type !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      p = mapMockPath(p);
      store.set(p, { type: "file", content: data });
    }),
    cpSync: vi.fn((src: string, dest: string) => {
      src = mapMockPath(src);
      dest = mapMockPath(dest);
      for (const [k, v] of store) {
        if (k === src || k.startsWith(src + "/")) {
          const relative = k.slice(src.length);
          store.set(dest + relative, { ...v });
        }
      }
    }),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      oldPath = mapMockPath(oldPath);
      newPath = mapMockPath(newPath);
      for (const [k, v] of [...store]) {
        if (k === oldPath || k.startsWith(oldPath + "/")) {
          const relative = k.slice(oldPath.length);
          store.set(newPath + relative, v);
          store.delete(k);
        }
      }
    }),
    rmSync: vi.fn((target: string) => {
      target = mapMockPath(target);
      rmFailures.has(target) && throwFsError("EACCES", `EACCES: permission denied, rm '${target}'`);
      for (const k of [...store.keys()]) {
        if (k === target || k.startsWith(target + "/")) {
          store.delete(k);
        }
      }
    }),
    readdirSync: (p: string, opts?: { withFileTypes?: boolean }) => {
      p = mapMockPath(p);
      const prefix = p.endsWith("/") ? p : p + "/";
      const childTypes = new Map<string, "file" | "dir" | "symlink">();
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const name = rest.split("/")[0];
          if (!name) continue;
          const isNested = rest.includes("/");
          if (!childTypes.has(name)) {
            childTypes.set(name, isNested ? "dir" : v.type);
          } else if (isNested) {
            childTypes.set(name, "dir");
          }
        }
      }
      if (childTypes.size === 0 && !store.has(p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      if (opts?.withFileTypes) {
        return [...childTypes].map(([name, type]) => ({
          name,
          isDirectory: () => type === "dir",
          isFile: () => type === "file",
          isSymbolicLink: () => type === "symlink",
        }));
      }
      return [...childTypes.keys()].sort();
    },
  };
});

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_command: string, args: string[]) => {
    const snapshotName = args[3];
    const snapshotsDir = args[2];
    if (
      snapshotDeleteHelperFails ||
      snapshotsDir !== MOCK_SNAPSHOTS_DIR ||
      typeof snapshotName !== "string" ||
      snapshotName.includes("/")
    ) {
      return { status: 1, stderr: "" };
    }
    const target = `${MOCK_SNAPSHOTS_DIR}/${snapshotName}`;
    const targetEntry = store.get(target);
    const hasChildren = [...store.keys()].some((key) => key.startsWith(`${target}/`));
    if (targetEntry === undefined && !hasChildren) {
      return { status: 0, stderr: "" };
    }
    if (
      targetEntry?.type === "symlink" ||
      (targetEntry !== undefined && targetEntry.type !== "dir")
    ) {
      return { status: 1, stderr: "" };
    }
    if (rmFailures.has(target)) {
      return { status: 1, stderr: "" };
    }
    for (const key of [...store.keys()]) {
      if (key === target || key.startsWith(`${target}/`)) {
        store.delete(key);
      }
    }
    return { status: 0, stderr: "" };
  }),
}));

const mockExeca = vi.fn();
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));

const {
  createSnapshot,
  restoreIntoSandbox,
  cutoverHost,
  rollbackFromSnapshot,
  listSnapshots,
  moveSync,
  deleteSnapshot,
  isSnapshotPathInsideSnapshotsDir,
  pruneSnapshots,
} = await import("./snapshot.js");

const { actionSnapshots } = await import("./runner.js");

const OPENCLAW_DIR = `${FAKE_HOME}/.openclaw`;
const SNAPSHOTS_DIR = MOCK_SNAPSHOTS_DIR;

// ── Tests ───────────────────────────────────────────────────────

describe("snapshot", () => {
  beforeEach(() => {
    store.clear();
    rmFailures.clear();
    snapshotDeleteHelperFails = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createSnapshot", () => {
    it("returns null when ~/.openclaw does not exist", () => {
      expect(createSnapshot()).toBeNull();
    });

    it("copies ~/.openclaw and writes manifest", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"version":"1"}');
      addFile(`${OPENCLAW_DIR}/hooks/demo/HOOK.md`, "# hook");

      const result = createSnapshot();

      expect(result).not.toBeNull();
      if (!result) throw new Error("createSnapshot returned null");

      expect(result.startsWith(SNAPSHOTS_DIR)).toBe(true);

      // Manifest was written
      const manifestPath = `${result}/snapshot.json`;
      const entry = store.get(manifestPath);
      if (!entry?.content) throw new Error("manifest not written");
      const manifest = JSON.parse(entry.content);
      expect(manifest.source).toBe(OPENCLAW_DIR);
      expect(manifest.file_count).toBe(2);
      expect(manifest.contents).toContain("openclaw.json");
      expect(manifest.contents).toContain("hooks/demo/HOOK.md");
    });

    it("rejects when ~/.openclaw is a symlink", () => {
      addSymlink(OPENCLAW_DIR, "/etc");

      expect(() => createSnapshot()).toThrow(/symbolic link/);
    });

    it("rejects when an ancestor of ~/.nemoclaw is a symlink", () => {
      addDir(OPENCLAW_DIR);
      addSymlink(`${FAKE_HOME}/.nemoclaw`, "/attacker-controlled");

      expect(() => createSnapshot()).toThrow(/symbolic link/);
    });

    it("records symlinks in manifest when present in tree", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"version":"1"}');
      addSymlink(`${OPENCLAW_DIR}/evil`, "/etc/shadow");

      const result = createSnapshot();
      expect(result).not.toBeNull();
      if (!result) throw new Error("createSnapshot returned null");

      const manifestPath = `${result}/snapshot.json`;
      const entry = store.get(manifestPath);
      if (!entry?.content) throw new Error("manifest not written");
      const manifest = JSON.parse(entry.content);
      expect(manifest.file_count).toBe(1);
      expect(manifest.contents).toContain("openclaw.json");
      expect(manifest.symlinks).toContain("evil");
    });
  });

  describe("restoreIntoSandbox", () => {
    it("returns false when snapshot has no openclaw dir", async () => {
      addDir(SNAP);
      expect(await restoreIntoSandbox(SNAP)).toBe(false);
    });

    it("calls openshell sandbox cp and returns true on success", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 0 });

      expect(await restoreIntoSandbox(SNAP, "mybox")).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "cp", `${SNAP}/openclaw`, "mybox:/sandbox/.openclaw"],
        { reject: false },
      );
    });

    it("returns false when openshell fails", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 1 });

      expect(await restoreIntoSandbox(SNAP)).toBe(false);
    });

    it("uses default sandbox name 'openclaw'", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 0 });

      await restoreIntoSandbox(SNAP);
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        expect.arrayContaining(["openclaw:/sandbox/.openclaw"]),
        expect.anything(),
      );
    });

    it("rejects invalid sandbox names before invoking openshell", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValue({ exitCode: 0, stderr: "" });

      await expect(restoreIntoSandbox(SNAP, "mybox;id")).rejects.toThrow(/Invalid sandbox name/);
      expect(mockExeca).not.toHaveBeenCalled();
    });

    it("truncates extremely long sandbox names in error message", async () => {
      addDir(`${SNAP}/openclaw`);
      const longName = "a".repeat(200);

      const error = await restoreIntoSandbox(SNAP, longName).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      // The full 200-char name must NOT appear — only the first 80 chars + ellipsis
      expect((error as Error).message).toContain("…");
      expect((error as Error).message).not.toContain(longName);
      expect(mockExeca).not.toHaveBeenCalled();
    });

    it("repairs legacy symlinks before best-effort chown after successful copy", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // cp
        .mockResolvedValueOnce({ exitCode: 0, stderr: "" }) // legacy symlink repair
        .mockResolvedValueOnce({ exitCode: 0, stderr: "" }); // chown

      expect(await restoreIntoSandbox(SNAP, "mybox")).toBe(true);
      expect(mockExeca).toHaveBeenCalledTimes(3);
      expect(mockExeca).toHaveBeenNthCalledWith(
        2,
        "openshell",
        expect.arrayContaining(["sandbox", "exec", "mybox", "--", "bash", "-lc"]),
        { reject: false },
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        3,
        "openshell",
        ["sandbox", "exec", "mybox", "--", "chown", "-R", "sandbox:sandbox", "/sandbox/.openclaw"],
        { reject: false },
      );
    });

    it("returns true even when chown fails (best-effort)", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca
        .mockResolvedValueOnce({ exitCode: 0 }) // cp succeeds
        .mockResolvedValueOnce({ exitCode: 0, stderr: "" }) // legacy symlink repair
        .mockResolvedValueOnce({ exitCode: 1, stderr: "chown: operation not permitted" }); // chown fails

      expect(await restoreIntoSandbox(SNAP, "mybox")).toBe(true);
    });

    it("does not call chown when cp fails", async () => {
      addDir(`${SNAP}/openclaw`);
      mockExeca.mockResolvedValueOnce({ exitCode: 1 }); // cp fails

      expect(await restoreIntoSandbox(SNAP)).toBe(false);
      expect(mockExeca).toHaveBeenCalledTimes(1);
    });
  });

  describe("moveSync", () => {
    it("uses renameSync when on the same device", () => {
      addDir("/src-dir");
      addFile("/src-dir/file.txt", "hello");

      moveSync("/src-dir", "/dest-dir");

      expect(store.has("/dest-dir/file.txt")).toBe(true);
      expect(store.has("/src-dir")).toBe(false);
    });

    it("falls back to cpSync + rmSync when renameSync throws EXDEV", async () => {
      addDir("/xdev-src");
      addFile("/xdev-src/file.txt", "cross-device");

      const fs = await import("node:fs");
      const { renameSync: mockRename, cpSync: mockCp } = vi.mocked(fs);

      // First call: throw EXDEV (cross-device)
      const exdevError = Object.assign(new Error("EXDEV: cross-device link not permitted"), {
        code: "EXDEV",
        errno: -18,
        syscall: "rename",
      });
      mockRename.mockImplementationOnce(() => {
        throw exdevError;
      });

      // cpSync mock: copy entries from src to dest (default mock behavior)
      // rmSync mock: exists via import

      moveSync("/xdev-src", "/xdev-dest");

      // cpSync should have been called as fallback
      expect(mockCp).toHaveBeenCalledWith("/xdev-src", "/xdev-dest", { recursive: true });
    });

    it("re-throws non-EXDEV errors from renameSync", async () => {
      addDir("/eperm-src");

      const fs = await import("node:fs");
      const { renameSync: mockRename } = vi.mocked(fs);

      mockRename.mockImplementationOnce(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      });

      expect(() => {
        moveSync("/eperm-src", "/eperm-dest");
      }).toThrow("EPERM");
    });
  });

  describe("cutoverHost", () => {
    it("returns true when ~/.openclaw does not exist", () => {
      expect(cutoverHost()).toBe(true);
    });

    it("renames ~/.openclaw to archive path", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, "{}");

      expect(cutoverHost()).toBe(true);
      expect(store.has(OPENCLAW_DIR)).toBe(false);

      // Archived under a .openclaw.pre-nemoclaw.* name
      const archived = [...store.keys()].find((k) => k.includes(".openclaw.pre-nemoclaw."));
      expect(archived).toBeDefined();
    });

    it("returns false when rename fails", async () => {
      addDir(OPENCLAW_DIR);
      const fs = await import("node:fs");
      const { renameSync } = vi.mocked(fs);
      renameSync.mockImplementationOnce(() => {
        throw new Error("EPERM");
      });

      expect(cutoverHost()).toBe(false);
    });
  });

  describe("rollbackFromSnapshot", () => {
    it("returns false when snapshot openclaw dir is missing", () => {
      addDir(SNAP);
      expect(rollbackFromSnapshot(SNAP)).toBe(false);
    });

    it("restores snapshot to ~/.openclaw with content", () => {
      addDir(`${SNAP}/openclaw`);
      addFile(`${SNAP}/openclaw/openclaw.json`, '{"restored":true}');

      expect(rollbackFromSnapshot(SNAP)).toBe(true);

      const restored = store.get(`${OPENCLAW_DIR}/openclaw.json`);
      if (!restored) throw new Error("openclaw.json not restored");
      expect(restored.content).toBe('{"restored":true}');
    });

    it("archives existing ~/.openclaw before restoring", () => {
      addDir(OPENCLAW_DIR);
      addFile(`${OPENCLAW_DIR}/openclaw.json`, '{"old":true}');
      addDir(`${SNAP}/openclaw`);
      addFile(`${SNAP}/openclaw/openclaw.json`, '{"restored":true}');

      expect(rollbackFromSnapshot(SNAP)).toBe(true);

      const archived = [...store.keys()].find((k) => k.includes(".openclaw.nemoclaw-archived."));
      expect(archived).toBeDefined();
    });

    it("returns false when ~/.openclaw is a symlink", () => {
      addDir(`${SNAP}/openclaw`);
      addFile(`${SNAP}/openclaw/openclaw.json`, '{"restored":true}');
      addSymlink(OPENCLAW_DIR, "/attacker-controlled");

      expect(rollbackFromSnapshot(SNAP)).toBe(false);
    });
  });

  describe("listSnapshots", () => {
    it("returns empty array when snapshots dir does not exist", () => {
      expect(listSnapshots()).toEqual([]);
    });

    it("returns manifests sorted newest-first", () => {
      const snap1 = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      const snap2 = `${SNAPSHOTS_DIR}/20260201T000000Z`;
      addDir(snap1);
      addFile(
        `${snap1}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: ["a.txt"],
        }),
      );
      addDir(snap2);
      addFile(
        `${snap2}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260201T000000Z",
          source: OPENCLAW_DIR,
          file_count: 2,
          contents: ["a.txt", "b.txt"],
        }),
      );

      const result = listSnapshots();
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe("20260201T000000Z");
      expect(result[1].timestamp).toBe("20260101T000000Z");
      expect(result[0].path).toBe(snap2);
    });

    it("uses the direct-child directory name as trusted snapshot identity", () => {
      const older = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      const newer = `${SNAPSHOTS_DIR}/20260201T000000Z`;
      addDir(older);
      addFile(
        `${older}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260301T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );
      addDir(newer);
      addFile(
        `${newer}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260201T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );

      expect(listSnapshots().map((snapshot) => snapshot.timestamp)).toEqual(["20260201T000000Z"]);
    });

    it("skips snapshot directories without strict timestamp names", () => {
      const snap = `${SNAPSHOTS_DIR}/not-a-snapshot`;
      addDir(snap);
      addFile(
        `${snap}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260401T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );

      expect(listSnapshots()).toEqual([]);
    });

    it("skips snapshots with corrupt manifests", () => {
      const snap1 = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      addDir(snap1);
      addFile(`${snap1}/snapshot.json`, "NOT VALID JSON");

      expect(listSnapshots()).toEqual([]);
    });

    it("skips non-directory entries", () => {
      addFile(`${SNAPSHOTS_DIR}/stray-file.txt`, "oops");

      expect(listSnapshots()).toEqual([]);
    });
  });

  describe("deleteSnapshot", () => {
    it("removes a snapshot directory", () => {
      addDir(`${SNAPSHOTS_DIR}/20260101T000000Z`);
      addFile(`${SNAPSHOTS_DIR}/20260101T000000Z/snapshot.json`, "{}");

      expect(deleteSnapshot(`${SNAPSHOTS_DIR}/20260101T000000Z`)).toBe(true);
      expect(store.has(`${SNAPSHOTS_DIR}/20260101T000000Z`)).toBe(false);
    });

    it("returns false when path is a symlink", () => {
      addSymlink(`${SNAPSHOTS_DIR}/evil`, "/attacker");

      expect(deleteSnapshot(`${SNAPSHOTS_DIR}/evil`)).toBe(false);
    });

    it("fails closed when the anchored delete helper fails", () => {
      const snap = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      addDir(snap);
      addFile(`${snap}/snapshot.json`, "{}");
      snapshotDeleteHelperFails = true;

      expect(deleteSnapshot(snap)).toBe(false);
      expect(store.has(snap)).toBe(true);
    });

    it("returns true for a non-existent timestamp-named path", () => {
      expect(deleteSnapshot(`${SNAPSHOTS_DIR}/20260401T000000Z`)).toBe(true);
    });

    it("rejects non timestamp-named children", () => {
      expect(deleteSnapshot(`${SNAPSHOTS_DIR}/nonexistent`)).toBe(false);
    });

    it("rejects path outside SNAPSHOTS_DIR", () => {
      expect(deleteSnapshot("/tmp/unauthorized")).toBe(false);
      expect(deleteSnapshot("/etc")).toBe(false);
    });

    it("rejects the snapshots root path", () => {
      addDir(SNAPSHOTS_DIR);

      expect(isSnapshotPathInsideSnapshotsDir(SNAPSHOTS_DIR)).toBe(false);
      expect(deleteSnapshot(SNAPSHOTS_DIR)).toBe(false);
      expect(store.has(SNAPSHOTS_DIR)).toBe(true);
    });
  });

  describe("pruneSnapshots", () => {
    it("keeps N snapshots and deletes the rest", () => {
      addDir(`${SNAPSHOTS_DIR}/20260101T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260101T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );
      addDir(`${SNAPSHOTS_DIR}/20260201T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260201T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260201T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );
      addDir(`${SNAPSHOTS_DIR}/20260301T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260301T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260301T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );

      const result = pruneSnapshots(2);

      expect(result.kept).toHaveLength(2);
      expect(result.deleted).toHaveLength(1);
      expect(result.failed).toHaveLength(0);
      expect(result.kept[0]).toContain("20260301T000000Z");
      expect(result.kept[1]).toContain("20260201T000000Z");
      expect(result.deleted[0]).toContain("20260101T000000Z");
      // Verify the deleted snapshot is actually removed from the store
      expect(store.has(`${SNAPSHOTS_DIR}/20260101T000000Z`)).toBe(false);
      expect(store.has(`${SNAPSHOTS_DIR}/20260201T000000Z`)).toBe(true);
      expect(store.has(`${SNAPSHOTS_DIR}/20260301T000000Z`)).toBe(true);
    });

    it("returns empty deleted when keep >= snapshot count", () => {
      addDir(`${SNAPSHOTS_DIR}/20260101T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260101T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );

      const result = pruneSnapshots(5);

      expect(result.deleted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.kept).toHaveLength(1);
    });

    it("handles no snapshots gracefully", () => {
      const result = pruneSnapshots(3);

      expect(result.deleted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.kept).toHaveLength(0);
    });

    it("returns empty arrays for negative keep", () => {
      addDir(`${SNAPSHOTS_DIR}/20260101T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260101T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );

      const result = pruneSnapshots(-1);

      expect(result.deleted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.kept).toHaveLength(0);
    });

    it("reports failures when deleteSnapshot returns false", () => {
      addDir(`${SNAPSHOTS_DIR}/20260101T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260101T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: OPENCLAW_DIR,
          file_count: 2,
          contents: [],
        }),
      );
      addDir(`${SNAPSHOTS_DIR}/20260201T000000Z`);
      addFile(
        `${SNAPSHOTS_DIR}/20260201T000000Z/snapshot.json`,
        JSON.stringify({
          timestamp: "20260201T000000Z",
          source: OPENCLAW_DIR,
          file_count: 2,
          contents: [],
        }),
      );
      // Make the older snapshot a symlink so deleteSnapshot rejects it
      addSymlink(`${SNAPSHOTS_DIR}/20260101T000000Z`, "/attacker");

      const result = pruneSnapshots(1);

      expect(result.deleted).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.kept).toHaveLength(1);
      expect(result.failed[0]).toContain("20260101T000000Z");
      expect(result.kept[0]).toContain("20260201T000000Z");
    });

    it("orders prune from strict directory identity, not mutable manifest timestamps", () => {
      const older = `${SNAPSHOTS_DIR}/20260101T000000Z`;
      const newer = `${SNAPSHOTS_DIR}/20260201T000000Z`;
      addDir(older);
      addFile(
        `${older}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260301T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );
      addDir(newer);
      addFile(
        `${newer}/snapshot.json`,
        JSON.stringify({
          timestamp: "20260201T000000Z",
          source: OPENCLAW_DIR,
          file_count: 1,
          contents: [],
        }),
      );

      const result = pruneSnapshots(1);

      expect(result.kept).toEqual([newer]);
      expect(result.deleted).toEqual([]);
      expect(store.has(older)).toBe(true);
      expect(store.has(newer)).toBe(true);
    });
  });

  describe("actionSnapshots (CLI dispatch)", () => {
    const stdoutChunks: string[] = [];

    function captureStdout(): void {
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    }

    function stdoutText(): string {
      return stdoutChunks.join("");
    }

    beforeEach(() => {
      store.clear();
      rmFailures.clear();
      snapshotDeleteHelperFails = false;
      stdoutChunks.length = 0;
      vi.clearAllMocks();
      captureStdout();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([["--help"], ["-h"], []])("shows usage for %j", (...argv) => {
      actionSnapshots(argv);
      expect(stdoutText()).toContain("Usage: snapshots <list|prune|delete>");
    });

    it("throws on unknown subcommand", () => {
      expect(() => actionSnapshots(["bogus"])).toThrow(/Unknown snapshots subcommand/);
    });

    it("lists snapshots when none exist", () => {
      actionSnapshots(["list"]);
      expect(stdoutText()).toContain("No snapshots found.");
    });

    it("lists existing snapshots", () => {
      const snapDir = `${FAKE_HOME}/.nemoclaw/snapshots/20260101T000000Z`;
      addDir(snapDir);
      addFile(
        snapDir + "/snapshot.json",
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: FAKE_HOME,
          file_count: 1,
          contents: [],
        }),
      );
      actionSnapshots(["list"]);
      expect(stdoutText()).toContain("20260101T000000Z");
    });

    it("strips controls from listed mutable manifest fields", () => {
      const snapDir = `${FAKE_HOME}/.nemoclaw/snapshots/20260101T000000Z`;
      addDir(snapDir);
      addFile(
        snapDir + "/snapshot.json",
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: `${FAKE_HOME}\u001b[31m/evil`,
          file_count: 1,
          contents: [],
        }),
      );
      actionSnapshots(["list"]);
      expect(stdoutText()).not.toContain("\u001b");
      expect(stdoutText()).toContain(`${FAKE_HOME}?[31m/evil`);
    });

    it("prune --keep N deletes oldest", () => {
      [1, 2, 3].forEach((n) => {
        const ts = `2026010${n}T000000Z`;
        addDir(`${FAKE_HOME}/.nemoclaw/snapshots/${ts}`);
        addFile(
          `${FAKE_HOME}/.nemoclaw/snapshots/${ts}/snapshot.json`,
          JSON.stringify({ timestamp: ts, source: FAKE_HOME, file_count: 1, contents: [] }),
        );
      });
      actionSnapshots(["prune", "--keep", "2"]);
      expect(stdoutText()).toContain("Pruned 1 snapshot(s), kept 2");
    });

    it("prune reports failed paths and exits nonzero when deletion fails", () => {
      ["20260101T000000Z", "20260201T000000Z"].forEach((ts) => {
        const snapDir = `${FAKE_HOME}/.nemoclaw/snapshots/${ts}`;
        addDir(snapDir);
        addFile(
          `${snapDir}/snapshot.json`,
          JSON.stringify({ timestamp: ts, source: FAKE_HOME, file_count: 1, contents: [] }),
        );
      });
      rmFailures.add(`${FAKE_HOME}/.nemoclaw/snapshots/20260101T000000Z`);

      expect(() => actionSnapshots(["prune", "--keep", "1"])).toThrow(
        "Failed to prune 1 snapshot(s)",
      );
      expect(stdoutText()).toContain("Failed:");
      expect(stdoutText()).toContain("20260101T000000Z");
    });

    it.each([["prune"], ["delete"]])("%s throws without required arg", (...argv) => {
      expect(() => actionSnapshots(argv)).toThrow();
    });

    it("prune rejects --keep with non-numeric suffix", () => {
      expect(() => actionSnapshots(["prune", "--keep", "3abc"])).toThrow(
        "--keep must be a non-negative integer",
      );
      expect(() => actionSnapshots(["prune", "--keep", "1.5"])).toThrow(
        "--keep must be a non-negative integer",
      );
    });

    it("delete rejects path outside SNAPSHOTS_DIR", () => {
      expect(() => actionSnapshots(["delete", "--path", "/tmp/unauthorized"])).toThrow(
        "Snapshot path must be inside the snapshots directory",
      );
    });

    it("delete rejects the snapshots root path", () => {
      addDir(SNAPSHOTS_DIR);

      expect(() => actionSnapshots(["delete", "--path", SNAPSHOTS_DIR])).toThrow(
        "Snapshot path must be inside the snapshots directory",
      );
      expect(store.has(SNAPSHOTS_DIR)).toBe(true);
    });

    it("delete removes a snapshot by path", () => {
      const sd = `${FAKE_HOME}/.nemoclaw/snapshots/20260101T000000Z`;
      addDir(sd);
      addFile(
        sd + "/snapshot.json",
        JSON.stringify({
          timestamp: "20260101T000000Z",
          source: FAKE_HOME,
          file_count: 1,
          contents: [],
        }),
      );
      actionSnapshots(["delete", "--path", sd]);
      expect(stdoutText()).toContain(`Deleted snapshot: ${sd}`);
    });

    it("delete succeeds on a non-existent timestamp-named path", () => {
      actionSnapshots(["delete", "--path", `${FAKE_HOME}/.nemoclaw/snapshots/20260401T000000Z`]);
      expect(stdoutText()).toContain("Deleted snapshot:");
    });
  });
});
