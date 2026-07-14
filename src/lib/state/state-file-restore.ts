// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";

import {
  type OpenShellSandboxControl,
  type SandboxExecRequest,
  validateOpenShellExecRequest,
} from "../adapters/openshell/sandbox-control.js";
import {
  cleanupSandboxPayloadAfterFailure,
  createPrivateSandboxPayloadFile,
  createPrivateSandboxPayloadFileFromPath,
  createSandboxPayloadRemotePath,
  uploadSandboxPayloadFile,
} from "../adapters/openshell/sandbox-upload.js";
import type { StateFileRestoreOwnership } from "../agent/defs.js";
import { buildOpenClawConfigRestoreInputFromSandbox } from "./openclaw-config-restore-input.js";
import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore.js";
import { KEY_ALLOWLIST_MERGE_PYTHON, stateFileKeyMergeSpec } from "./state-file-key-merge.js";

export interface StateFileRestoreSpec {
  path: string;
  strategy: "copy" | "sqlite_backup";
}

const STATE_FILE_RESTORE_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_STATE_FILE_RESTORE_BYTES = 256 * 1024 * 1024;
export const MAX_TRANSFORMED_STATE_FILE_RESTORE_BYTES = 16 * 1024 * 1024;
export const STATE_FILE_RESTORE_OK = "STATE_FILE_OK";
export const KEY_ALLOWLIST_RESTORE_OK = "KEY_ALLOWLIST_OK";

type BoundedStateFileReadResult = { ok: true; contents: Buffer } | { ok: false; error: string };

function readBoundedStateFile(localPath: string, maxBytes: number): BoundedStateFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(localPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) {
      return {
        ok: false,
        error: `state file is not regular or exceeds ${String(maxBytes)} bytes`,
      };
    }
    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.length) {
      const count = readSync(fd, contents, offset, contents.length - offset, null);
      if (count === 0) return { ok: false, error: "state file changed while reading" };
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) {
      return { ok: false, error: "state file exceeds bounded size while reading" };
    }
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      return { ok: false, error: "state file changed while reading" };
    }
    return { ok: true, contents };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: detail.substring(0, 200) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const STATE_FILE_RESTORE_PYTHON = String.raw`import hashlib, json, os, posixpath, re, secrets, sqlite3, stat, sys, tempfile, urllib.parse

MAX_BYTES = 256 * 1024 * 1024
CHUNK = 64 * 1024
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(20)

def safe_text(value):
    return isinstance(value, str) and 0 < len(value) <= 4096 and not any(ord(c) < 32 or ord(c) == 127 for c in value)

def open_absolute_parent(pathname):
    if not safe_text(pathname) or not posixpath.isabs(pathname) or posixpath.normpath(pathname) != pathname or pathname == "/":
        fail("invalid staged state file path")
    parts = pathname.split("/")[1:]
    parent = os.open("/", DIR_FLAGS)
    try:
        for component in parts[:-1]:
            child = os.open(component, DIR_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent, parts[-1]
    except BaseException:
        os.close(parent)
        raise

def open_absolute_dir(pathname):
    if not safe_text(pathname) or not posixpath.isabs(pathname) or posixpath.normpath(pathname) != pathname or pathname == "/":
        fail("invalid state file root")
    current = os.open("/", DIR_FLAGS)
    try:
        for component in pathname.split("/")[1:]:
            child = os.open(component, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def open_relative_parent(root_fd, relative):
    if not safe_text(relative) or posixpath.isabs(relative) or "\\" in relative or posixpath.normpath(relative) != relative or relative in (".", "..") or relative.startswith("../"):
        fail("invalid state file path")
    parts = relative.split("/")
    current = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            try:
                child = os.open(component, DIR_FLAGS, dir_fd=current)
            except FileNotFoundError:
                os.mkdir(component, 0o700, dir_fd=current)
                child = os.open(component, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current, parts[-1]
    except BaseException:
        os.close(current)
        raise

def ensure_replaceable(parent_fd, name, label):
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        fail(label + " is not a single regular file")

def private_name(prefix):
    return prefix + secrets.token_hex(12)

def copy_fd(source_fd, output_fd):
    os.lseek(source_fd, 0, os.SEEK_SET)
    total = 0
    digest = hashlib.sha256()
    while True:
        chunk = os.read(source_fd, CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_BYTES:
            fail("staged state file exceeds restore limit")
        digest.update(chunk)
        view = memoryview(chunk)
        while view:
            written = os.write(output_fd, view)
            if written <= 0:
                fail("could not write staged state file")
            view = view[written:]
    return digest.hexdigest()

def private_snapshot(source_fd, expected_size):
    snapshot = tempfile.TemporaryFile()
    try:
        digest = copy_fd(source_fd, snapshot.fileno())
        if os.fstat(snapshot.fileno()).st_size != expected_size:
            fail("staged state file changed while snapshotting")
        os.fsync(snapshot.fileno())
        os.fchmod(snapshot.fileno(), 0o400)
        os.lseek(snapshot.fileno(), 0, os.SEEK_SET)
        return snapshot, digest
    except BaseException:
        snapshot.close()
        raise

def write_copy(source_fd, parent_fd, destination, refresh):
    ensure_replaceable(parent_fd, destination, "state file destination")
    last_good = destination + ".last-good"
    hash_name = ".config-hash"
    if refresh:
        ensure_replaceable(parent_fd, last_good, "last-good destination")
        ensure_replaceable(parent_fd, hash_name, "config hash destination")
    staged_name = None
    anchor_name = None
    hash_stage = None
    try:
        staged_name = private_name(".nemoclaw-restore-")
        staged_fd = os.open(staged_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
        try:
            digest = copy_fd(source_fd, staged_fd)
            os.fchmod(staged_fd, 0o640)
            os.fsync(staged_fd)
        finally:
            os.close(staged_fd)
        if refresh:
            anchor_name = private_name(".nemoclaw-lastgood-")
            anchor_fd = os.open(anchor_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
            try:
                copy_fd(source_fd, anchor_fd)
                os.fchmod(anchor_fd, 0o660)
                os.fsync(anchor_fd)
            finally:
                os.close(anchor_fd)
            hash_stage = private_name(".nemoclaw-hash-")
            hash_fd = os.open(hash_stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
            try:
                payload = (digest + "  " + destination + "\n").encode("ascii")
                view = memoryview(payload)
                while view:
                    written = os.write(hash_fd, view)
                    if written <= 0:
                        fail("could not write config hash")
                    view = view[written:]
                os.fchmod(hash_fd, 0o660)
                os.fsync(hash_fd)
            finally:
                os.close(hash_fd)

        if refresh:
            os.replace(anchor_name, last_good, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            anchor_name = None
        os.replace(staged_name, destination, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        staged_name = None
        if refresh:
            os.replace(hash_stage, hash_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            hash_stage = None
        os.fsync(parent_fd)
    finally:
        for name in (staged_name, anchor_name, hash_stage):
            if name is not None:
                try:
                    os.unlink(name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass

def write_sqlite(source_fd, parent_fd, destination):
    ensure_replaceable(parent_fd, destination, "sqlite destination")
    source_name = None
    staged_name = None
    portable_dir = None
    source_path = None
    staged_path = None
    source_db = None
    destination_db = None
    try:
        source_name = private_name(".nemoclaw-sqlite-source-")
        source_copy = os.open(source_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
        try:
            copy_fd(source_fd, source_copy)
            os.fsync(source_copy)
        finally:
            os.close(source_copy)
        staged_name = private_name(".nemoclaw-sqlite-restore-")
        if os.path.isdir("/proc/self/fd"):
            source_path = "/proc/self/fd/" + str(parent_fd) + "/" + source_name
            staged_path = "/proc/self/fd/" + str(parent_fd) + "/" + staged_name
        else:
            portable_dir = tempfile.mkdtemp(prefix="nemoclaw-sqlite-restore-")
            os.chmod(portable_dir, 0o700)
            source_path = os.path.join(portable_dir, "source.sqlite")
            staged_path = os.path.join(portable_dir, "restored.sqlite")
            portable_source = os.open(source_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                copy_fd(source_fd, portable_source)
                os.fsync(portable_source)
            finally:
                os.close(portable_source)
        source_uri = "file:" + urllib.parse.quote(source_path, safe="/") + "?mode=ro&immutable=1"
        source_db = sqlite3.connect(source_uri, uri=True, timeout=30)
        destination_db = sqlite3.connect(staged_path, timeout=30)
        destination_db.execute("PRAGMA busy_timeout=30000")
        source_db.backup(destination_db)
        row = destination_db.execute("PRAGMA quick_check").fetchone()
        if not row or row[0] != "ok":
            fail("sqlite quick_check failed")
        destination_db.close()
        destination_db = None
        source_db.close()
        source_db = None
        if portable_dir is None:
            staged_fd = os.open(staged_name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
            try:
                os.fchmod(staged_fd, 0o660)
                os.fsync(staged_fd)
            finally:
                os.close(staged_fd)
        else:
            portable_metadata = os.stat(staged_path, follow_symlinks=False)
            portable_fd = os.open(staged_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(portable_fd)
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (portable_metadata.st_dev, portable_metadata.st_ino):
                    fail("unsafe staged sqlite restore")
                staged_fd = os.open(staged_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
                try:
                    copy_fd(portable_fd, staged_fd)
                    os.fchmod(staged_fd, 0o660)
                    os.fsync(staged_fd)
                finally:
                    os.close(staged_fd)
            finally:
                os.close(portable_fd)
        os.replace(staged_name, destination, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        staged_name = None
        os.fsync(parent_fd)
    finally:
        if destination_db is not None:
            destination_db.close()
        if source_db is not None:
            source_db.close()
        for name in (source_name, staged_name):
            if name is not None:
                try:
                    os.unlink(name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
        if portable_dir is not None:
            for entry in os.scandir(portable_dir):
                if entry.is_dir(follow_symlinks=False):
                    fail("unexpected sqlite restore staging directory")
                os.unlink(entry.path)
            os.rmdir(portable_dir)

if len(sys.argv) != 7:
    fail("state file restore requires staged path, root, path, strategy, refresh flag, and digest")
remote_path, state_root, relative_path, strategy, refresh_raw, expected_digest = sys.argv[1:]
if not posixpath.basename(remote_path).startswith("nemoclaw-state-restore-"):
    fail("invalid staged state file path")
if strategy not in ("copy", "sqlite_backup") or refresh_raw not in ("0", "1"):
    fail("invalid state file restore strategy")
if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
    fail("invalid staged state file digest")
remote_parent, remote_name = open_absolute_parent(remote_path)
source_fd = None
root_fd = None
target_parent = None
snapshot = None
try:
    before = os.stat(remote_name, dir_fd=remote_parent, follow_symlinks=False)
    source_fd = os.open(remote_name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=remote_parent)
    opened = os.fstat(source_fd)
    if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or opened.st_size > MAX_BYTES or opened.st_uid != os.geteuid() or opened.st_gid != os.getegid() or opened.st_mode & 0o022 or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
        fail("unsafe staged state file")
    os.unlink(remote_name, dir_fd=remote_parent)
    source_baseline = os.fstat(source_fd)
    snapshot, actual_digest = private_snapshot(source_fd, source_baseline.st_size)
    source_after = os.fstat(source_fd)
    if source_after.st_size != source_baseline.st_size or source_after.st_mtime_ns != source_baseline.st_mtime_ns or source_after.st_ctime_ns != source_baseline.st_ctime_ns:
        fail("staged state file changed while snapshotting")
    if actual_digest != expected_digest:
        fail("staged state file digest mismatch")
    os.close(source_fd)
    source_fd = None
    root_fd = open_absolute_dir(state_root)
    target_parent, destination = open_relative_parent(root_fd, relative_path)
    if strategy == "sqlite_backup":
        write_sqlite(snapshot.fileno(), target_parent, destination)
    else:
        write_copy(snapshot.fileno(), target_parent, destination, refresh_raw == "1")
finally:
    if target_parent is not None:
        os.close(target_parent)
    if root_fd is not None:
        os.close(root_fd)
    if source_fd is not None:
        os.close(source_fd)
    if snapshot is not None:
        snapshot.close()
    os.close(remote_parent)
print("STATE_FILE_OK")
`;

export async function restoreStateFile(
  sandboxControl: OpenShellSandboxControl,
  sandboxName: string,
  dir: string,
  spec: StateFileRestoreSpec,
  backupPath: string,
  ownership: StateFileRestoreOwnership | undefined,
  allowCustomImageWholeStateFileRestore: boolean,
  log: (message: string) => void,
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[],
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[],
  gatewayName = "nemoclaw",
): Promise<boolean> {
  const localPath = path.join(backupPath, spec.path);
  if (!existsSync(localPath)) return true;

  log(`Restoring state file ${spec.path} (${spec.strategy})`);

  let input: Buffer | null | undefined;
  let refreshOpenClawConfigHash = false;
  let keyAllowlistOwnership: Extract<StateFileRestoreOwnership, { merge: "key-allowlist" }> | null =
    null;
  if (ownership?.merge === "openclaw-config") {
    const boundedRead = readBoundedStateFile(localPath, MAX_TRANSFORMED_STATE_FILE_RESTORE_BYTES);
    if (!boundedRead.ok) {
      log(`FAILED: state file restore ${spec.path}: ${boundedRead.error}`);
      return false;
    }
    refreshOpenClawConfigHash = true;
    const result = await buildOpenClawConfigRestoreInputFromSandbox({
      backupContents: boundedRead.contents,
      dir,
      freshImagePluginInstalls,
      log,
      previousImagePluginInstalls,
      sandboxControl,
      sandboxName,
      specPath: spec.path,
    });
    if (result.ok) {
      input = result.input;
    } else {
      log(`FAILED: ${result.error}`);
      input = null;
    }
  } else if (ownership?.merge === "key-allowlist") {
    if (!allowCustomImageWholeStateFileRestore) keyAllowlistOwnership = ownership;
    input = undefined;
  } else {
    input = undefined;
  }
  if (input === null) return false;
  if (input && input.length > MAX_TRANSFORMED_STATE_FILE_RESTORE_BYTES) {
    log(`FAILED: state file restore ${spec.path}: transformed input exceeds restore limit`);
    return false;
  }

  const remotePath = createSandboxPayloadRemotePath();
  const staged =
    input !== undefined
      ? createPrivateSandboxPayloadFile(input)
      : createPrivateSandboxPayloadFileFromPath(
          localPath,
          keyAllowlistOwnership
            ? MAX_TRANSFORMED_STATE_FILE_RESTORE_BYTES
            : MAX_STATE_FILE_RESTORE_BYTES,
        );
  if (!staged.ok) {
    log(`FAILED: state file restore ${spec.path}: ${staged.error}`);
    return false;
  }
  const request: SandboxExecRequest = keyAllowlistOwnership
    ? {
        sandboxName,
        command: [
          "/opt/venv/bin/python3",
          "-I",
          "-",
          dir,
          spec.path,
          JSON.stringify(stateFileKeyMergeSpec(keyAllowlistOwnership)),
          remotePath,
          staged.payload.sha256,
        ],
        stdin: KEY_ALLOWLIST_MERGE_PYTHON,
        timeoutMs: 120_000,
        maxOutputBytes: STATE_FILE_RESTORE_MAX_OUTPUT_BYTES,
      }
    : {
        sandboxName,
        command: [
          "python3",
          "-I",
          "-",
          remotePath,
          dir,
          spec.path,
          spec.strategy,
          refreshOpenClawConfigHash ? "1" : "0",
          staged.payload.sha256,
        ],
        stdin: STATE_FILE_RESTORE_PYTHON,
        timeoutMs: 120_000,
        maxOutputBytes: STATE_FILE_RESTORE_MAX_OUTPUT_BYTES,
      };
  const validationError = validateOpenShellExecRequest(request);
  if (validationError) {
    staged.payload.cleanup();
    log(`FAILED: state file restore ${spec.path}: ${validationError.message}`);
    return false;
  }
  let upload;
  try {
    upload = uploadSandboxPayloadFile(
      gatewayName,
      sandboxName,
      staged.payload.localPath,
      remotePath,
    );
  } finally {
    staged.payload.cleanup();
  }
  const cleanupRemotePayload = async (): Promise<void> => {
    if (!(await cleanupSandboxPayloadAfterFailure(sandboxControl, sandboxName, remotePath))) {
      log(`WARNING: could not confirm cleanup of staged state file ${spec.path} at ${remotePath}`);
    }
  };
  if (!upload.ok) {
    await cleanupRemotePayload();
    log(`FAILED: state file restore ${spec.path} upload: ${upload.error}`);
    return false;
  }

  let result;
  try {
    result = await sandboxControl.exec(request);
  } catch (cause) {
    await cleanupRemotePayload();
    const detail = cause instanceof Error ? cause.message : String(cause);
    log(`FAILED: state file restore ${spec.path}: ${detail.substring(0, 200)}`);
    return false;
  }

  const expectedSentinel = keyAllowlistOwnership ? KEY_ALLOWLIST_RESTORE_OK : STATE_FILE_RESTORE_OK;
  if (
    result.status === 0 &&
    !result.error &&
    !result.signal &&
    result.stdout.trim() === expectedSentinel
  ) {
    return true;
  }

  await cleanupRemotePayload();

  const detail =
    result.stderr.trim() ||
    result.error?.message ||
    (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
  log(`FAILED: state file restore ${spec.path}: ${detail.substring(0, 200)}`);
  return false;
}
