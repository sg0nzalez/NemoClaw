// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertNoOpenShellGatewayEndpointOverride,
  type OpenShellGatewayEndpointEnvironment,
} from "../../openshell-gateway-endpoint-guard.js";
import { captureOpenshell } from "./runtime.js";
import {
  type OpenShellSandboxControl,
  type SandboxExecRequest,
  validateOpenShellExecRequest,
} from "./sandbox-control.js";

type CaptureOpenshell = typeof captureOpenshell;

export const SANDBOX_PAYLOAD_UPLOAD_TIMEOUT_MS = 120_000;
export const SANDBOX_PAYLOAD_UPLOAD_MAX_OUTPUT_BYTES = 64 * 1024;
export const SANDBOX_PAYLOAD_CLEANUP_TIMEOUT_MS = 30_000;
export const SANDBOX_PAYLOAD_CLEANUP_MAX_OUTPUT_BYTES = 64 * 1024;
export const SANDBOX_PAYLOAD_CLEANUP_MAX_ATTEMPTS = 2;
export const SANDBOX_PAYLOAD_CLEANUP_OK = "SANDBOX_PAYLOAD_CLEANUP_OK";

const SANDBOX_PAYLOAD_REMOTE_PATH_RE =
  /^\/tmp\/nemoclaw-state-restore-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export const SANDBOX_PAYLOAD_CLEANUP_PYTHON = String.raw`import os, posixpath, re, sys

DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(20)

if len(sys.argv) != 2:
    fail("cleanup requires one staged payload path")
remote_path = sys.argv[1]
if not isinstance(remote_path, str) or posixpath.normpath(remote_path) != remote_path or not re.fullmatch(r"/tmp/nemoclaw-state-restore-[A-Za-z0-9][A-Za-z0-9-]{0,127}", remote_path):
    fail("invalid staged payload cleanup path")
parent_fd = os.open("/tmp", DIR_FLAGS)
try:
    name = posixpath.basename(remote_path)
    try:
        os.unlink(name, dir_fd=parent_fd)
    except FileNotFoundError:
        pass
finally:
    os.close(parent_fd)
print("SANDBOX_PAYLOAD_CLEANUP_OK")
`;

export interface SandboxPayloadUploadDependencies {
  capture?: CaptureOpenshell;
  env?: OpenShellGatewayEndpointEnvironment;
}

export type SandboxPayloadUploadResult =
  | { ok: true; remotePath: string }
  | { ok: false; error: string; remotePath: string };

export interface PrivateSandboxPayloadFile {
  readonly localPath: string;
  readonly sha256: string;
  cleanup(): void;
}

export type PrivateSandboxPayloadFileResult =
  | { ok: true; payload: PrivateSandboxPayloadFile }
  | { ok: false; error: string };

export function createSandboxPayloadRemotePath(randomId: () => string = randomUUID): string {
  return `/tmp/nemoclaw-state-restore-${randomId()}`;
}

export function createPrivateSandboxPayloadFile(payload: Buffer): PrivateSandboxPayloadFileResult {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-upload-"));
    chmodSync(tempDir, 0o700);
    const localPath = path.join(tempDir, "payload");
    writeFileSync(localPath, payload, { flag: "wx", mode: 0o600 });
    const ownedTempDir = tempDir;
    let cleaned = false;
    return {
      ok: true,
      payload: {
        localPath,
        sha256: createHash("sha256").update(payload).digest("hex"),
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          rmSync(ownedTempDir, { recursive: true, force: true });
        },
      },
    };
  } catch (cause) {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: detail.substring(0, 200) };
  }
}

function writeAllSync(fd: number, contents: Buffer): void {
  let offset = 0;
  while (offset < contents.length) {
    const written = writeSync(fd, contents, offset, contents.length - offset);
    if (written <= 0) throw new Error("could not write private sandbox payload");
    offset += written;
  }
}

/** Snapshot a host file into private bounded staging without allocating its full contents. */
export function createPrivateSandboxPayloadFileFromPath(
  sourcePath: string,
  maxBytes: number,
): PrivateSandboxPayloadFileResult {
  let tempDir: string | undefined;
  let sourceFd: number | undefined;
  let outputFd: number | undefined;
  let complete = false;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      return { ok: false, error: "invalid sandbox payload size limit" };
    }
    tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-upload-"));
    chmodSync(tempDir, 0o700);
    const localPath = path.join(tempDir, "payload");
    sourceFd = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(sourceFd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) {
      return {
        ok: false,
        error: `source is not a single regular file within ${String(maxBytes)} bytes`,
      };
    }
    outputFd = openSync(
      localPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    const chunk = Buffer.alloc(64 * 1024);
    const digest = createHash("sha256");
    let total = 0;
    for (;;) {
      const count = readSync(sourceFd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) {
        return { ok: false, error: `source exceeds ${String(maxBytes)} bytes while staging` };
      }
      digest.update(chunk.subarray(0, count));
      writeAllSync(outputFd, chunk.subarray(0, count));
    }
    const after = fstatSync(sourceFd);
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      return { ok: false, error: "source changed while staging sandbox payload" };
    }
    fsyncSync(outputFd);
    closeSync(outputFd);
    outputFd = undefined;
    closeSync(sourceFd);
    sourceFd = undefined;
    const ownedTempDir = tempDir;
    let cleaned = false;
    complete = true;
    return {
      ok: true,
      payload: {
        localPath,
        sha256: digest.digest("hex"),
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          rmSync(ownedTempDir, { recursive: true, force: true });
        },
      },
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: detail.substring(0, 200) };
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (tempDir && !complete) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Upload one already-private host file through OpenShell's supported command.
 *
 * Restore payloads may exceed ExecSandbox's unary request ceiling. The caller
 * owns local staging and cleanup; this boundary owns exact gateway routing,
 * endpoint-override rejection, option termination, and bounded diagnostics.
 */
export function uploadSandboxPayloadFile(
  gatewayName: string,
  sandboxName: string,
  localPath: string,
  remotePath: string,
  dependencies: SandboxPayloadUploadDependencies = {},
): SandboxPayloadUploadResult {
  try {
    assertNoOpenShellGatewayEndpointOverride(dependencies.env ?? process.env);
    const result = (dependencies.capture ?? captureOpenshell)(
      ["sandbox", "upload", "-g", gatewayName, "--", sandboxName, localPath, remotePath],
      {
        ignoreError: true,
        includeStreams: true,
        timeout: SANDBOX_PAYLOAD_UPLOAD_TIMEOUT_MS,
        maxBuffer: SANDBOX_PAYLOAD_UPLOAD_MAX_OUTPUT_BYTES,
      },
    );
    if (result.status === 0 && !result.error && !result.signal) {
      return { ok: true, remotePath };
    }
    const detail =
      result.stderr?.trim() ||
      result.output.trim() ||
      result.error?.message ||
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    return { ok: false, error: detail.substring(0, 200), remotePath };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: detail.substring(0, 200), remotePath };
  }
}

/**
 * Bounded, non-replaying cleanup for a possibly uploaded private payload.
 *
 * The exact-path unlink is idempotent, so an unconfirmed first attempt gets one
 * identical cleanup-only recovery attempt. At most two 30-second calls can run;
 * this recovery never redispatches the upload or restore operation.
 * Remove this recovery when OpenShell provides transactional upload-and-restore,
 * a server-confirmed idempotent delete, or lease expiry for staged payloads.
 */
export async function cleanupSandboxPayloadAfterFailure(
  sandboxControl: OpenShellSandboxControl,
  sandboxName: string,
  remotePath: string,
): Promise<boolean> {
  if (!SANDBOX_PAYLOAD_REMOTE_PATH_RE.test(remotePath)) return false;
  const request: SandboxExecRequest = {
    sandboxName,
    command: ["python3", "-I", "-", remotePath],
    stdin: SANDBOX_PAYLOAD_CLEANUP_PYTHON,
    timeoutMs: SANDBOX_PAYLOAD_CLEANUP_TIMEOUT_MS,
    maxOutputBytes: SANDBOX_PAYLOAD_CLEANUP_MAX_OUTPUT_BYTES,
  };
  if (validateOpenShellExecRequest(request)) return false;
  for (let attempt = 0; attempt < SANDBOX_PAYLOAD_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await sandboxControl.exec(request);
      if (
        result.status === 0 &&
        !result.error &&
        !result.signal &&
        result.stdout.trim() === SANDBOX_PAYLOAD_CLEANUP_OK
      ) {
        return true;
      }
    } catch {
      // A failed attempt is unconfirmed; the loop remains cleanup-only and bounded above.
    }
  }
  return false;
}
