// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> share mount|unmount|status`.
 *
 * Live filesystem mounts depended on the legacy SSH filesystem transport.
 * Under the gRPC-only sandbox lifecycle, mount is intentionally unsupported;
 * status and unmount remain for cleaning up older local mounts.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { buildShareCommandDeps } from "./share-command-deps";
import type { ShareCommandDeps } from "./share-command-deps";

export class ShareCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "ShareCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function shareFail(lines: string | readonly string[], exitCode = 1): never {
  throw new ShareCommandError(lines, exitCode);
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check whether a path is an active mount point.
 * Uses `mountpoint -q` on Linux (reliable), falls back to parsing
 * `mount` output on macOS or when mountpoint is unavailable.
 */
export function isMountPoint(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (process.platform !== "darwin") {
    const mp = spawnSync("mountpoint", ["-q", resolved], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (mp.status === 0) return true;
    if (mp.status === 1) return false;
  }
  const result = spawnSync("mount", [], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return false;
  const escaped = resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(` on ${escaped}(?: |$)`);
  return pattern.test(result.stdout || "");
}

export function defaultShareMountDir(sandboxName: string): string {
  return path.join(process.env.HOME || os.homedir(), ".nemoclaw", "mounts", sandboxName);
}

/**
 * Pre-flight: confirm the remote source path actually exists inside the
 * sandbox. Retained for older tests and any future non-mount copy flow.
 * Returns normally when the path can be verified; emits a structured error
 * and exits the process non-zero when it cannot. The success path has no
 * return value.
 */
export function assertSandboxPathExistsOrExit(
  deps: ShareCommandDeps,
  sandboxName: string,
  remotePath: string,
): void {
  if (deps.checkSandboxPathExists(sandboxName, remotePath)) return;
  // The probe returns false for both "path is missing" and "exec itself
  // failed" (transient gRPC, sandbox just restarted, etc.), so phrase the
  // headline as a verification failure rather than a definitive claim that
  // the path is missing.
  console.error(
    `  Could not verify sandbox path '${remotePath}' in sandbox '${sandboxName}' (missing path or probe failure).`,
  );
  console.error(
    `  Verify the path with: ${deps.cliName} ${sandboxName} connect, then ls ${remotePath}`,
  );
  console.error(`  The default is /sandbox; check for typos in any custom path you passed.`);
  process.exit(1);
}

/**
 * Resolve the fusermount binary for Linux. FUSE 3 ships `fusermount3`;
 * older FUSE 2 ships `fusermount`. Probe both, preferring v3.
 */
export function resolveLinuxUnmount(): string | null {
  for (const cmd of ["fusermount3", "fusermount"]) {
    const probe = spawnSync("sh", ["-c", `command -v ${cmd}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (probe.status === 0 && (probe.stdout || "").trim()) {
      return (probe.stdout || "").trim();
    }
  }
  return null;
}

/**
 * Verify that `localMount` exists and is writable so FUSE can mount onto it.
 * Creates the directory (recursive) if missing, and reports the specific
 * failure reason (read-only filesystem, permission denied, etc.) when the
 * mount target is unusable. Returning a structured result instead of
 * throwing keeps the helper unit-testable; the caller decides how to surface
 * the error to the user.
 */
export function checkLocalMountWritable(localMount: string): { writable: boolean; reason?: string } {
  try {
    // Node's fs.mkdirSync(path, { recursive: true }) masks EROFS as ENOENT when
    // the leaf is missing on a read-only parent (#4311). Use non-recursive mkdir
    // when the parent already exists so EROFS propagates with its true errno;
    // fall back to recursive only when the parent is genuinely missing.
    if (fs.existsSync(path.dirname(localMount))) {
      try {
        fs.mkdirSync(localMount);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw err;
        if (!fs.statSync(localMount).isDirectory()) {
          return { writable: false, reason: "mount target exists and is not a directory" };
        }
      }
    } else {
      fs.mkdirSync(localMount, { recursive: true });
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EROFS") return { writable: false, reason: "parent filesystem is read-only" };
    if (code === "EACCES") return { writable: false, reason: "permission denied creating the directory" };
    return { writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    fs.accessSync(localMount, fs.constants.W_OK);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EROFS") return { writable: false, reason: "filesystem is read-only" };
    if (code === "EACCES") return { writable: false, reason: "directory is not writable" };
    return { writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { writable: true };
}

export type ShareMountOptions = {
  sandboxName: string;
  remotePath?: string;
  localMount?: string;
};

export type ShareUnmountOptions = {
  sandboxName: string;
  localMount?: string;
};

export type ShareStatusOptions = {
  sandboxName: string;
  localMount?: string;
};

export async function runShareMount(
  options: ShareMountOptions,
  deps: ShareCommandDeps = buildShareCommandDeps(),
): Promise<void> {
  const { sandboxName } = options;
  await deps.ensureLive(sandboxName);
  shareFail([
    "  Live sandbox filesystem mounts are no longer supported.",
    "  NemoClaw now uses OpenShell SDK for sandbox lifecycle operations, and OpenShell does not provide a live filesystem mount API on that transport.",
    `  Existing legacy mounts can still be inspected or removed with '${deps.cliName} ${sandboxName} share status' and '${deps.cliName} ${sandboxName} share unmount'.`,
  ]);
}

export function runShareUnmount(
  options: ShareUnmountOptions,
  deps: ShareCommandDeps = buildShareCommandDeps(),
): void {
  const { sandboxName } = options;
  const localMount = options.localMount || defaultShareMountDir(sandboxName);
  const G = deps.colorGreen;
  const R = deps.colorReset;

  let unmountCmd: string;
  let unmountArgs: string[];
  if (process.platform === "darwin") {
    unmountCmd = "umount";
    unmountArgs = [localMount];
  } else {
    const resolved = resolveLinuxUnmount();
    if (!resolved) {
      shareFail([
        "  Could not find fusermount3 or fusermount on this host.",
        "  Install with: sudo apt-get install fuse3  (or: sudo dnf install fuse3)",
      ]);
    }
    unmountCmd = resolved;
    unmountArgs = ["-u", localMount];
  }

  const result = spawnSync(unmountCmd, unmountArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (/not mounted|not found|no mount/i.test(stderr)) {
      shareFail(`  ${localMount} is not currently mounted.`);
    }
    const lines = [`  Unmount failed: ${stderr || "unknown error"}`];
    if (process.platform !== "darwin") {
      lines.push(`  Try: ${unmountCmd} -uz ${localMount}`);
    }
    shareFail(lines);
  }
  console.log(`  ${G}✓${R} Unmounted ${localMount}`);
}

export function runShareStatus(
  options: ShareStatusOptions,
  deps: ShareCommandDeps = buildShareCommandDeps(),
): void {
  const { sandboxName } = options;
  const localMount = options.localMount || defaultShareMountDir(sandboxName);
  const G = deps.colorGreen;
  const R = deps.colorReset;
  if (isMountPoint(localMount)) {
    console.log(`  ${G}●${R} Mounted at ${localMount}`);
  } else {
    console.log(`  ○ Not mounted (expected at ${localMount})`);
  }
}

export function printShareUsageAndExit(exitCode = 1): never {
  const { cliName } = buildShareCommandDeps();
  shareFail([
    `  Usage: ${cliName} <name> share <mount|unmount|status>`,
    "    mount   [sandbox-path] [local-mount-point]  Unsupported under gRPC-only transport",
    "    unmount [local-mount-point]                 Unmount a previously mounted filesystem",
    "    status  [local-mount-point]                 Check current mount status",
  ], exitCode);
}
