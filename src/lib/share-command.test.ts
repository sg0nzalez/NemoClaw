// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  defaultShareMountDir,
  isMountPoint,
  resolveLinuxUnmount,
  runShareMount,
  runShareStatus,
  ShareCommandError,
} from "./share-command";
import type { ShareCommandDeps } from "./share-command-deps";

function makeDeps(overrides: Partial<ShareCommandDeps> = {}): ShareCommandDeps {
  return {
    ensureLive: vi.fn(async () => undefined),
    checkSandboxPathExists: vi.fn(() => true),
    colorGreen: "",
    colorReset: "",
    cliName: "nemoclaw",
    ...overrides,
  };
}

function mountedAt(dir: string): string {
  return `/dev/fuse on ${path.resolve(dir)} type fuse.sshfs (rw)\n`;
}

function withProcessPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

describe("share-command helpers", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the default mount directory under ~/.nemoclaw/mounts", () => {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = "/home/tester";
      expect(defaultShareMountDir("alpha")).toBe("/home/tester/.nemoclaw/mounts/alpha");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("falls back to mount output when mountpoint is unavailable", () => {
    withProcessPlatform("linux", () => {
      const dir = "/tmp/nemoclaw-share-mounted";
      spawnSyncMock.mockImplementation((cmd: string) => {
        if (cmd === "mountpoint") return { status: 127 };
        if (cmd === "mount") return { status: 0, stdout: mountedAt(dir) };
        return { status: 1, stdout: "", stderr: "" };
      });

      expect(isMountPoint(dir)).toBe(true);
    });
  });

  it("trusts mountpoint -q status 1 as not mounted on Linux", () => {
    withProcessPlatform("linux", () => {
      spawnSyncMock.mockImplementation((cmd: string) => {
        if (cmd === "mountpoint") return { status: 1 };
        if (cmd === "mount") throw new Error("mount fallback should not run");
        return { status: 1, stdout: "", stderr: "" };
      });

      expect(isMountPoint("/tmp/nemoclaw-share-not-mounted")).toBe(false);
    });
  });

  it("prefers fusermount3 over fusermount on Linux", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] as string;
      if (script.includes("fusermount3")) return { status: 0, stdout: "/usr/bin/fusermount3\n" };
      if (script.includes("fusermount")) return { status: 0, stdout: "/usr/bin/fusermount\n" };
      return { status: 1, stdout: "" };
    });

    expect(resolveLinuxUnmount()).toBe("/usr/bin/fusermount3");
  });

  it("falls back to fusermount when fusermount3 is unavailable", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] as string;
      if (script.includes("fusermount3")) return { status: 1, stdout: "" };
      if (script.includes("fusermount")) return { status: 0, stdout: "/bin/fusermount\n" };
      return { status: 1, stdout: "" };
    });

    expect(resolveLinuxUnmount()).toBe("/bin/fusermount");
  });
});

describe("ShareCommand mount/status actions", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("rejects live mounts under the gRPC-only transport", async () => {
    const deps = makeDeps();
    const localMount = fs.mkdtempSync(path.join(process.cwd(), ".tmp-share-mount-"));
    try {
      await expect(
        runShareMount({ sandboxName: "alpha", remotePath: "/workspace", localMount }, deps),
      ).rejects.toThrow(/Live sandbox filesystem mounts are no longer supported/);
      expect(deps.ensureLive).toHaveBeenCalledWith("alpha");
      expect(spawnSyncMock).not.toHaveBeenCalledWith("sshfs", expect.any(Array), expect.anything());
    } finally {
      fs.rmSync(localMount, { recursive: true, force: true });
    }
  });

  it("does not require host mount tools before reporting unsupported mount", async () => {
    const deps = makeDeps();
    await expect(runShareMount({ sandboxName: "alpha" }, deps)).rejects.toThrow(
      ShareCommandError,
    );
    await expect(runShareMount({ sandboxName: "alpha" }, deps)).rejects.toThrow(
      /OpenShell SDK/,
    );
    expect(deps.ensureLive).toHaveBeenCalledWith("alpha");
  });

  it("still checks sandbox liveness before reporting unsupported mount", async () => {
    const deps = makeDeps();
    const localMount = fs.mkdtempSync(path.join(process.cwd(), ".tmp-share-sftp-"));
    try {
      await expect(
        runShareMount({ sandboxName: "alpha", remotePath: "/sandbox", localMount }, deps),
      ).rejects.toThrow(/share status/);
      expect(deps.ensureLive).toHaveBeenCalledWith("alpha");
    } finally {
      fs.rmSync(localMount, { recursive: true, force: true });
    }
  });

  it("prints mounted status when the local mount point is active", () => {
    const mountDir = "/tmp/nemoclaw-share-status";
    spawnSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "mountpoint") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "mount") return { status: 0, stdout: mountedAt(mountDir), stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    });

    runShareStatus({ sandboxName: "alpha", localMount: mountDir }, makeDeps());

    expect(logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n")).toContain(
      `Mounted at ${mountDir}`,
    );
  });
});
