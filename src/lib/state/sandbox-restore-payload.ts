// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSafeOpenClawExtensionDirName } from "./openclaw-plugin-restore.js";

export const STATE_DIRECTORY_RESTORE_MAGIC = Buffer.from("NEMOCLAW_STATE_RESTORE\0", "ascii");
export const STATE_DIRECTORY_RESTORE_VERSION = 1;
export const MAX_STATE_DIRECTORY_RESTORE_METADATA_BYTES = 512 * 1024;
export const MAX_STATE_DIRECTORY_RESTORE_DIRS = 16 * 1024;
export const MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS = 256;
export const MAX_STATE_DIRECTORY_RESTORE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const STATE_DIRECTORY_RESTORE_HEADER_BYTES = STATE_DIRECTORY_RESTORE_MAGIC.length + 1 + 4;
const STATE_DIRECTORY_RESTORE_TAR_TIMEOUT_MS = 60_000;
const STATE_DIRECTORY_RESTORE_TAR_DIAGNOSTIC_BYTES = 64 * 1024;

export interface ManagedExtensionRestoreRecord {
  readonly name: string;
  readonly required: boolean;
}

interface StateDirectoryRestoreMetadata {
  readonly directories: readonly string[];
  readonly managedExtensions: readonly (readonly [string, boolean])[];
}

export interface StateDirectoryRestorePayload {
  readonly localPath: string;
  readonly remotePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  cleanup(): void;
}

export type StateDirectoryRestorePayloadResult =
  | { ok: true; payload: StateDirectoryRestorePayload }
  | { ok: false; error: string };

export type StateDirectoryRestoreMetadataResult =
  | { ok: true; metadata: Buffer }
  | { ok: false; error: string };

function isSafeRestoreDirectoryName(name: string): boolean {
  if (
    name.length === 0 ||
    name.length > 4096 ||
    name.includes("\0") ||
    name.includes("\r") ||
    name.includes("\n") ||
    name.includes("\\") ||
    path.posix.isAbsolute(name)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(name);
  return (
    normalized === name &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function validateRestoreDirectories(directories: readonly string[]): string | null {
  if (directories.length === 0 || directories.length > MAX_STATE_DIRECTORY_RESTORE_DIRS) {
    return `state directory restore requires 1-${String(MAX_STATE_DIRECTORY_RESTORE_DIRS)} directories`;
  }
  const seen = new Set<string>();
  for (const directory of directories) {
    if (!isSafeRestoreDirectoryName(directory)) {
      return `state directory restore contains an unsafe directory name: ${JSON.stringify(directory)}`;
    }
    if (seen.has(directory)) {
      return `state directory restore repeats directory ${JSON.stringify(directory)}`;
    }
    seen.add(directory);
  }
  for (const directory of directories) {
    const parts = directory.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/");
      if (seen.has(ancestor)) {
        return `state directory restore contains overlapping directories ${JSON.stringify(ancestor)} and ${JSON.stringify(directory)}`;
      }
    }
  }
  return null;
}

function validateManagedExtensions(
  directories: readonly string[],
  managedExtensions: readonly ManagedExtensionRestoreRecord[],
): string | null {
  if (managedExtensions.length > MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS) {
    return `state directory restore exceeds ${String(MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS)} managed extensions`;
  }
  if (managedExtensions.length > 0 && !directories.includes("extensions")) {
    return "managed extensions require the extensions state directory";
  }
  const seen = new Set<string>();
  for (const extension of managedExtensions) {
    if (!isSafeOpenClawExtensionDirName(extension.name) || seen.has(extension.name)) {
      return `state directory restore contains an unsafe or repeated managed extension: ${JSON.stringify(extension.name)}`;
    }
    seen.add(extension.name);
  }
  return null;
}

function validateArchiveExcludedExtensions(
  directories: readonly string[],
  extensions: readonly string[],
): string | null {
  if (extensions.length > MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS) {
    return `state directory restore exceeds ${String(MAX_STATE_DIRECTORY_RESTORE_MANAGED_EXTENSIONS)} archive-excluded extensions`;
  }
  if (extensions.length > 0 && !directories.includes("extensions")) {
    return "archive-excluded extensions require the extensions state directory";
  }
  const seen = new Set<string>();
  for (const extension of extensions) {
    if (!isSafeOpenClawExtensionDirName(extension) || seen.has(extension)) {
      return `state directory restore contains an unsafe or repeated archive-excluded extension: ${JSON.stringify(extension)}`;
    }
    seen.add(extension);
  }
  return null;
}

function payloadHeader(metadataBytes: number): Buffer {
  const header = Buffer.alloc(STATE_DIRECTORY_RESTORE_HEADER_BYTES);
  STATE_DIRECTORY_RESTORE_MAGIC.copy(header, 0);
  header.writeUInt8(STATE_DIRECTORY_RESTORE_VERSION, STATE_DIRECTORY_RESTORE_MAGIC.length);
  header.writeUInt32BE(metadataBytes, STATE_DIRECTORY_RESTORE_MAGIC.length + 1);
  return header;
}

function writeAllSync(fd: number, contents: Buffer): void {
  let offset = 0;
  while (offset < contents.length) {
    const written = writeSync(fd, contents, offset, contents.length - offset);
    if (written <= 0) throw new Error("could not write staged restore payload");
    offset += written;
  }
}

export function encodeStateDirectoryRestoreMetadata(
  directories: readonly string[],
  managedExtensions: readonly ManagedExtensionRestoreRecord[],
): StateDirectoryRestoreMetadataResult {
  const directoryError = validateRestoreDirectories(directories);
  if (directoryError) return { ok: false, error: directoryError };
  const extensionError = validateManagedExtensions(directories, managedExtensions);
  if (extensionError) return { ok: false, error: extensionError };
  const metadata: StateDirectoryRestoreMetadata = {
    directories,
    managedExtensions: managedExtensions.map(
      (extension) => [extension.name, extension.required] as const,
    ),
  };
  const encodedMetadata = Buffer.from(JSON.stringify(metadata), "utf8");
  if (encodedMetadata.length > MAX_STATE_DIRECTORY_RESTORE_METADATA_BYTES) {
    return {
      ok: false,
      error: `state directory restore metadata exceeds ${String(MAX_STATE_DIRECTORY_RESTORE_METADATA_BYTES)} bytes`,
    };
  }
  return { ok: true, metadata: encodedMetadata };
}

interface StreamedTarResult {
  error?: Error;
  overflow: boolean;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: Buffer;
}

function tarFailureDetail(result: StreamedTarResult): string {
  const stderr = result.stderr.toString("utf8").trim();
  return (
    stderr ||
    result.error?.message ||
    (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`)
  ).substring(0, 200);
}

function streamTarArchive(
  args: readonly string[],
  payloadFd: number,
  digest: Hash,
): Promise<StreamedTarResult> {
  return new Promise((resolve) => {
    const child = spawn("tar", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let archiveBytes = 0;
    let overflow = false;
    let writeError: Error | undefined;
    let spawnError: Error | undefined;

    child.stdout.on("data", (value: Buffer | string) => {
      if (overflow || writeError) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      archiveBytes += chunk.length;
      if (archiveBytes > MAX_STATE_DIRECTORY_RESTORE_ARCHIVE_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      try {
        digest.update(chunk);
        writeAllSync(payloadFd, chunk);
      } catch (cause) {
        writeError = cause instanceof Error ? cause : new Error(String(cause));
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (value: Buffer | string) => {
      if (stderrBytes >= STATE_DIRECTORY_RESTORE_TAR_DIAGNOSTIC_BYTES) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const retained = chunk.subarray(
        0,
        STATE_DIRECTORY_RESTORE_TAR_DIAGNOSTIC_BYTES - stderrBytes,
      );
      stderrChunks.push(retained);
      stderrBytes += retained.length;
    });
    child.once("error", (cause) => {
      spawnError = cause;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), STATE_DIRECTORY_RESTORE_TAR_TIMEOUT_MS);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        overflow,
        stderr: Buffer.concat(stderrChunks, stderrBytes),
        ...(writeError || spawnError ? { error: writeError ?? spawnError } : {}),
      });
    });
  });
}

/**
 * Build a framed restore file without retaining or concatenating the tar bytes.
 * Both GNU tar and bsdtar treat a NUL `-T` list as verbatim, which keeps the
 * command size constant for high-cardinality manifests.
 */
export async function createStateDirectoryRestorePayload(options: {
  backupPath: string;
  directories: readonly string[];
  managedExtensions: readonly ManagedExtensionRestoreRecord[];
  archiveExcludedExtensions?: readonly string[];
  remotePath: string;
}): Promise<StateDirectoryRestorePayloadResult> {
  const encoded = encodeStateDirectoryRestoreMetadata(
    options.directories,
    options.managedExtensions,
  );
  if (!encoded.ok) return encoded;
  const encodedMetadata = encoded.metadata;
  const archiveExcludedExtensions =
    options.archiveExcludedExtensions ?? options.managedExtensions.map(({ name }) => name);
  const archiveExclusionError = validateArchiveExcludedExtensions(
    options.directories,
    archiveExcludedExtensions,
  );
  if (archiveExclusionError) return { ok: false, error: archiveExclusionError };

  let tempDir: string | undefined;
  let payloadFd: number | undefined;
  let complete = false;
  try {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-restore-"));
    chmodSync(tempDir, 0o700);
    const payloadPath = path.join(tempDir, "payload");
    const namesPath = path.join(tempDir, "directories");
    payloadFd = openSync(payloadPath, "wx", 0o600);
    const digest = createHash("sha256");
    const header = payloadHeader(encodedMetadata.length);
    digest.update(header);
    writeAllSync(payloadFd, header);
    digest.update(encodedMetadata);
    writeAllSync(payloadFd, encodedMetadata);
    writeFileSync(namesPath, Buffer.from(`${options.directories.join("\0")}\0`, "utf8"), {
      flag: "wx",
      mode: 0o600,
    });

    const tarArgs = ["-cf", "-", "-C", options.backupPath];
    for (const extension of archiveExcludedExtensions) {
      tarArgs.push("--exclude", `extensions/${extension}`);
    }
    tarArgs.push("--null", "-T", namesPath);
    const tarResult = await streamTarArchive(tarArgs, payloadFd, digest);
    if (tarResult.overflow) {
      return {
        ok: false,
        error: `state directory restore archive exceeds ${String(MAX_STATE_DIRECTORY_RESTORE_ARCHIVE_BYTES)} bytes`,
      };
    }
    if (tarResult.status !== 0 || tarResult.error || tarResult.signal) {
      return {
        ok: false,
        error: `could not archive state directories: ${tarFailureDetail(tarResult)}`,
      };
    }
    fsyncSync(payloadFd);
    const sizeBytes = fstatSync(payloadFd).size;
    closeSync(payloadFd);
    payloadFd = undefined;
    rmSync(namesPath, { force: true });

    const ownedTempDir = tempDir;
    let cleaned = false;
    complete = true;
    return {
      ok: true,
      payload: {
        localPath: payloadPath,
        remotePath: options.remotePath,
        sha256: digest.digest("hex"),
        sizeBytes,
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          rmSync(ownedTempDir, { recursive: true, force: true });
        },
      },
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: `could not stage state directory restore: ${detail.substring(0, 200)}`,
    };
  } finally {
    if (payloadFd !== undefined) {
      try {
        closeSync(payloadFd);
      } catch {
        // The primary staging failure is more useful than close diagnostics.
      }
    }
    // Successful callers own the returned cleanup. Any early return still has
    // a live payload fd here or lacks a complete private payload.
    if (tempDir && !complete) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// This fixed program is the complete directory mutation surface. The staged
// pathname and root are the only argv values; all high-cardinality input stays
// in the bounded frame. It never calls extractall(), tar(1), chown, or chmod
// with archive special bits.
export const STATE_DIRECTORY_RESTORE_PYTHON = String.raw`import hashlib, json, os, posixpath, re, stat, struct, sys, tarfile, tempfile

MAGIC = b"NEMOCLAW_STATE_RESTORE\x00"
VERSION = 1
MAX_METADATA = 512 * 1024
MAX_DIRS = 16 * 1024
MAX_MANAGED = 256
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_PAYLOAD = len(MAGIC) + 1 + 4 + MAX_METADATA + MAX_ARCHIVE
MAX_MEMBERS = 65536
MAX_PATH = 4096
CHUNK = 64 * 1024
OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)

def fail(message, code=20):
    print(message, file=sys.stderr)
    raise SystemExit(code)

def safe_text(value, max_length=MAX_PATH):
    return isinstance(value, str) and 0 < len(value) <= max_length and not any(ord(c) < 32 or ord(c) == 127 for c in value)

def safe_relative(value):
    return safe_text(value) and "\\" not in value and not posixpath.isabs(value) and posixpath.normpath(value) == value and value not in (".", "..") and not value.startswith("../")

def safe_extension(value):
    return safe_text(value, 128) and value not in (".", "..") and not any(c in value for c in "/\\*?[]")

def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(min(CHUNK, remaining))
        if not chunk:
            fail("truncated state restore payload", 21)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def open_absolute_parent(pathname):
    if not safe_text(pathname) or not posixpath.isabs(pathname) or posixpath.normpath(pathname) != pathname or pathname == "/":
        fail("invalid staged restore path")
    parts = pathname.split("/")[1:]
    parent = os.open("/", OPEN_FLAGS)
    try:
        for component in parts[:-1]:
            child = os.open(component, OPEN_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent, parts[-1]
    except BaseException:
        os.close(parent)
        raise

def open_absolute_dir(pathname):
    if not safe_text(pathname) or not posixpath.isabs(pathname) or posixpath.normpath(pathname) != pathname or pathname == "/":
        fail("invalid state root")
    current = os.open("/", OPEN_FLAGS)
    try:
        for component in pathname.split("/")[1:]:
            child = os.open(component, OPEN_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def parse_metadata(stream):
    if read_exact(stream, len(MAGIC)) != MAGIC:
        fail("invalid state restore payload magic", 21)
    version = read_exact(stream, 1)[0]
    if version != VERSION:
        fail("unsupported state restore payload version", 21)
    metadata_size = struct.unpack(">I", read_exact(stream, 4))[0]
    if metadata_size > MAX_METADATA:
        fail("state restore metadata exceeds limit", 21)
    try:
        metadata = json.loads(read_exact(stream, metadata_size).decode("utf-8"))
    except (UnicodeError, ValueError):
        fail("invalid state restore metadata", 21)
    if not isinstance(metadata, dict) or set(metadata) != {"directories", "managedExtensions"}:
        fail("invalid state restore metadata shape", 21)
    directories = metadata["directories"]
    managed = metadata["managedExtensions"]
    if not isinstance(directories, list) or not 1 <= len(directories) <= MAX_DIRS:
        fail("invalid state restore directory count", 21)
    if not isinstance(managed, list) or len(managed) > MAX_MANAGED:
        fail("invalid managed extension count", 21)
    seen = set()
    for directory in directories:
        if not safe_relative(directory) or directory in seen:
            fail("invalid state restore directory", 21)
        seen.add(directory)
    for directory in directories:
        parts = directory.split("/")
        if any("/".join(parts[:index]) in seen for index in range(1, len(parts))):
            fail("overlapping state restore directories", 21)
    managed_records = []
    managed_names = set()
    for record in managed:
        if not isinstance(record, list) or len(record) != 2:
            fail("invalid managed extension record", 21)
        name, required = record
        if not safe_extension(name) or type(required) is not bool or name in managed_names:
            fail("invalid managed extension record", 21)
        managed_names.add(name)
        managed_records.append((name, required))
    if managed_records and "extensions" not in seen:
        fail("managed extensions require extensions directory", 21)
    return directories, managed_records

def member_within_directories(name, directory_set):
    if name in directory_set:
        return True
    parts = name.split("/")
    return any("/".join(parts[:index]) in directory_set for index in range(1, len(parts)))

def allowed_symlink(name, target):
    if not safe_text(target) or "%" in target:
        return False
    if re.fullmatch(r"extensions/[A-Za-z0-9][A-Za-z0-9._-]*/node_modules/openclaw", name):
        return target == "/usr/local/lib/node_modules/openclaw"
    if not re.fullmatch(r"extensions/[A-Za-z0-9][A-Za-z0-9._-]*/node_modules/\.bin/[^/]+", name):
        return False
    if posixpath.isabs(target):
        return False
    bin_dir = posixpath.dirname(name)
    modules_dir = posixpath.dirname(bin_dir)
    resolved = posixpath.normpath(posixpath.join(bin_dir, target))
    relative = posixpath.relpath(resolved, modules_dir)
    return relative not in (".", "..") and not relative.startswith("../") and not relative.startswith(".bin/")

def canonical_member_name(member):
    name = member.name
    return name[:-1] if member.isdir() and name.endswith("/") else name

def archive_record(member):
    kind = "directory" if member.isdir() else "file" if member.isreg() else "symlink" if member.issym() else "unsupported"
    return (canonical_member_name(member), kind, member.size, member.linkname, member.mode)

def consume_regular_member(archive, member):
    source = archive.extractfile(member)
    if source is None:
        fail("could not read state archive member", 22)
    remaining = member.size
    while remaining:
        chunk = source.read(min(CHUNK, remaining))
        if not chunk:
            fail("truncated state archive member", 22)
        remaining -= len(chunk)
    if source.read(1):
        fail("oversized state archive member", 22)

def validate_member(member, directory_set, managed_names, seen, non_directories, required_directories):
    name = canonical_member_name(member)
    if not safe_relative(name) or name in seen or not member_within_directories(name, directory_set):
        fail("unsafe or repeated state archive member", 22)
    if any(name == "extensions/" + managed or name.startswith("extensions/" + managed + "/") for managed in managed_names):
        fail("state archive replaces a managed extension", 22)
    record = archive_record(member)
    kind = record[1]
    if kind == "unsupported" or (kind == "symlink" and not allowed_symlink(name, member.linkname)):
        fail("unsupported state archive member type", 22)
    parts = name.split("/")
    ancestors = ["/".join(parts[:index]) for index in range(1, len(parts))]
    if any(ancestor in non_directories for ancestor in ancestors):
        fail("state archive member has a non-directory ancestor", 22)
    if kind != "directory" and name in required_directories:
        fail("state archive member conflicts with an existing child", 22)
    required_directories.update(ancestors)
    if kind != "directory":
        non_directories.add(name)
    seen.add(name)
    return record

def scan_archive(stream, tar_offset, directories, managed_names):
    stream.seek(tar_offset)
    seen = set()
    non_directories = set()
    required_directories = set()
    explicit_roots = set()
    records = []
    count = 0
    logical_bytes = 0
    directory_set = set(directories)
    try:
        archive = tarfile.open(fileobj=stream, mode="r:")
        try:
            for member in archive:
                count += 1
                if count > MAX_MEMBERS:
                    fail("state archive member count exceeds limit", 22)
                if member.size < 0 or member.issparse() or member.type == tarfile.GNUTYPE_SPARSE or any(key.startswith("GNU.sparse") for key in member.pax_headers):
                    fail("sparse state archive members are unsupported", 22)
                record = validate_member(member, directory_set, managed_names, seen, non_directories, required_directories)
                if record[0] in directory_set:
                    if record[1] != "directory" or member.mode & 0o700 != 0o700:
                        fail("state archive root is not a usable directory", 22)
                    explicit_roots.add(record[0])
                if member.isreg():
                    logical_bytes += member.size
                    if logical_bytes > MAX_ARCHIVE:
                        fail("state archive logical file bytes exceed limit", 22)
                    consume_regular_member(archive, member)
                records.append(record)
        finally:
            archive.close()
    except (tarfile.TarError, OSError) as error:
        fail("invalid state archive: " + str(error), 22)
    if explicit_roots != directory_set:
        fail("state archive is missing an explicit directory root", 22)
    return records

def open_dir_at(parent_fd, components, create):
    current = os.dup(parent_fd)
    try:
        for component in components:
            try:
                child = os.open(component, OPEN_FLAGS, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o700, dir_fd=current)
                child = os.open(component, OPEN_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def remove_entry(parent_fd, name):
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return
    child_fd = os.open(name, OPEN_FLAGS, dir_fd=parent_fd)
    try:
        opened = os.fstat(child_fd)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            fail("state directory changed during cleanup", 23)
        for entry in os.scandir(child_fd):
            remove_entry(child_fd, entry.name)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=parent_fd)

def open_parent_at(root_fd, relative, create):
    parts = relative.split("/")
    return open_dir_at(root_fd, parts[:-1], create), parts[-1]

def open_verified_directory(parent_fd, name, label):
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        raise
    if not stat.S_ISDIR(metadata.st_mode):
        fail(label + " is not a directory", 23)
    try:
        directory_fd = os.open(name, OPEN_FLAGS, dir_fd=parent_fd)
    except OSError:
        fail(label + " is not a safe directory", 23)
    opened = os.fstat(directory_fd)
    if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
        os.close(directory_fd)
        fail(label + " changed while opening", 23)
    if not os.access(name, os.R_OK | os.X_OK, dir_fd=parent_fd, follow_symlinks=False):
        os.close(directory_fd)
        fail(label + " is not usable", 23)
    return directory_fd, (opened.st_dev, opened.st_ino)

def validate_cleanup_targets(root_fd, directories, managed):
    managed_names = {name for name, _required in managed}
    managed_state = {"root": None, "entries": {}}
    for directory in directories:
        try:
            parent_fd, name = open_parent_at(root_fd, directory, False) if "/" in directory else (os.dup(root_fd), directory)
        except FileNotFoundError:
            continue
        try:
            if directory == "extensions" and managed_names:
                try:
                    extensions_fd, extensions_identity = open_verified_directory(
                        parent_fd, name, "managed extension root"
                    )
                except FileNotFoundError:
                    if any(required for _managed, required in managed):
                        fail("required managed extension root is missing", 23)
                    for managed_name, _required in managed:
                        managed_state["entries"][managed_name] = None
                    continue
                managed_state["root"] = extensions_identity
                try:
                    for managed_name, required in managed:
                        try:
                            managed_fd, managed_identity = open_verified_directory(
                                extensions_fd,
                                managed_name,
                                "managed extension " + managed_name,
                            )
                        except FileNotFoundError:
                            if required:
                                fail("required managed extension is missing: " + managed_name, 23)
                            managed_state["entries"][managed_name] = None
                            continue
                        os.close(managed_fd)
                        managed_state["entries"][managed_name] = managed_identity
                finally:
                    os.close(extensions_fd)
            else:
                try:
                    metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISLNK(metadata.st_mode):
                    continue
        finally:
            os.close(parent_fd)
    return managed_state

def clean_targets(root_fd, directories, managed, managed_state):
    managed_names = {name for name, _required in managed}
    for directory in directories:
        try:
            parent_fd, name = open_parent_at(root_fd, directory, False) if "/" in directory else (os.dup(root_fd), directory)
        except FileNotFoundError:
            continue
        try:
            if directory == "extensions" and managed_names:
                created_root = False
                try:
                    extensions_fd, actual_root = open_verified_directory(
                        parent_fd, name, "managed extension root"
                    )
                except FileNotFoundError:
                    os.mkdir(name, 0o700, dir_fd=parent_fd)
                    extensions_fd, actual_root = open_verified_directory(
                        parent_fd, name, "managed extension root"
                    )
                    created_root = True
                try:
                    expected_root = managed_state["root"]
                    if expected_root is None and not created_root:
                        fail("managed extension root appeared during restore", 23)
                    if expected_root is not None and actual_root != expected_root:
                        fail("managed extension root changed during restore", 23)
                    managed_state["root"] = actual_root
                    for entry in os.scandir(extensions_fd):
                        if entry.name not in managed_names:
                            remove_entry(extensions_fd, entry.name)
                finally:
                    os.close(extensions_fd)
            else:
                remove_entry(parent_fd, name)
        finally:
            os.close(parent_fd)

def verify_managed_extensions(root_fd, managed, managed_state):
    if not managed:
        return
    extensions_fd, root_identity = open_verified_directory(
        root_fd, "extensions", "managed extension root"
    )
    try:
        expected_root = managed_state["root"]
        if expected_root is not None and root_identity != expected_root:
            fail("managed extension root changed during restore", 25)
        for managed_name, required in managed:
            expected = managed_state["entries"].get(managed_name)
            try:
                managed_fd, actual = open_verified_directory(
                    extensions_fd,
                    managed_name,
                    "managed extension " + managed_name,
                )
            except FileNotFoundError:
                if required or expected is not None:
                    fail("managed extension disappeared during restore: " + managed_name, 25)
                continue
            os.close(managed_fd)
            if expected is None:
                fail("managed extension appeared during restore: " + managed_name, 25)
            if actual != expected:
                fail("managed extension changed during restore: " + managed_name, 25)
    finally:
        os.close(extensions_fd)

def extract_archive(stream, tar_offset, root_fd, expected_records):
    directory_modes = []
    record_index = 0
    stream.seek(tar_offset)
    archive = tarfile.open(fileobj=stream, mode="r:")
    try:
        for member in archive:
            record = archive_record(member)
            if record_index >= len(expected_records) or record != expected_records[record_index]:
                fail("state archive changed after validation", 24)
            record_index += 1
            member_name = record[0]
            parent_fd, name = open_parent_at(root_fd, member_name, True)
            try:
                mode = member.mode & 0o777
                if member.isdir():
                    try:
                        os.mkdir(name, 0o700, dir_fd=parent_fd)
                    except FileExistsError:
                        pass
                    directory_fd = os.open(name, OPEN_FLAGS, dir_fd=parent_fd)
                    os.close(directory_fd)
                    directory_modes.append((member_name, mode))
                elif member.isreg():
                    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                    output_fd = os.open(name, flags, mode or 0o600, dir_fd=parent_fd)
                    try:
                        source = archive.extractfile(member)
                        if source is None:
                            fail("could not read state archive member", 24)
                        remaining = member.size
                        while remaining:
                            chunk = source.read(min(CHUNK, remaining))
                            if not chunk:
                                fail("truncated state archive member", 24)
                            view = memoryview(chunk)
                            while view:
                                written = os.write(output_fd, view)
                                if written <= 0:
                                    fail("could not write state archive member", 24)
                                view = view[written:]
                            remaining -= len(chunk)
                        if source.read(1):
                            fail("oversized state archive member", 24)
                        os.fchmod(output_fd, mode)
                    finally:
                        os.close(output_fd)
                else:
                    os.symlink(member.linkname, name, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
    finally:
        archive.close()
    if record_index != len(expected_records):
        fail("state archive changed after validation", 24)
    for relative, mode in sorted(directory_modes, key=lambda item: item[0].count("/"), reverse=True):
        directory_fd = open_dir_at(root_fd, relative.split("/"), False)
        try:
            os.fchmod(directory_fd, mode)
        finally:
            os.close(directory_fd)

def verify_directories(root_fd, directories):
    for directory in directories:
        directory_fd = open_dir_at(root_fd, directory.split("/"), False)
        os.close(directory_fd)
        parent_fd, name = open_parent_at(root_fd, directory, False) if "/" in directory else (os.dup(root_fd), directory)
        try:
            if not os.access(name, os.R_OK | os.W_OK, dir_fd=parent_fd, follow_symlinks=False):
                fail("restored state directory is not usable: " + directory, 25)
        finally:
            os.close(parent_fd)

def copy_private_payload(source_fd, expected_size):
    private_stream = tempfile.TemporaryFile()
    total = 0
    digest = hashlib.sha256()
    try:
        while True:
            chunk = os.read(source_fd, CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_PAYLOAD:
                fail("staged restore payload exceeds limit")
            digest.update(chunk)
            private_stream.write(chunk)
        if total != expected_size:
            fail("staged restore payload changed while copying")
        private_stream.flush()
        os.fsync(private_stream.fileno())
        os.fchmod(private_stream.fileno(), 0o400)
        private_stream.seek(0)
        return private_stream, digest.hexdigest()
    except BaseException:
        private_stream.close()
        raise

if len(sys.argv) != 4:
    fail("state restore requires staged path, state root, and payload digest")
remote_path, state_root, expected_digest = sys.argv[1:]
if not posixpath.basename(remote_path).startswith("nemoclaw-state-restore-"):
    fail("invalid staged restore path")
if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
    fail("invalid staged restore digest")
parent_fd, basename = open_absolute_parent(remote_path)
payload_fd = None
root_fd = None
stream = None
try:
    before = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)
    payload_fd = os.open(basename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
    opened = os.fstat(payload_fd)
    if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or opened.st_size > MAX_PAYLOAD or opened.st_uid != os.geteuid() or opened.st_gid != os.getegid() or opened.st_mode & 0o022 or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
        fail("unsafe staged restore file")
    os.unlink(basename, dir_fd=parent_fd)
    source_baseline = os.fstat(payload_fd)
    stream, actual_digest = copy_private_payload(payload_fd, source_baseline.st_size)
    source_after = os.fstat(payload_fd)
    if source_after.st_size != source_baseline.st_size or source_after.st_mtime_ns != source_baseline.st_mtime_ns or source_after.st_ctime_ns != source_baseline.st_ctime_ns:
        fail("staged restore payload changed while copying")
    if actual_digest != expected_digest:
        fail("staged restore payload digest mismatch")
    os.close(payload_fd)
    payload_fd = None
    try:
        directories, managed = parse_metadata(stream)
        tar_offset = stream.tell()
        stream.seek(0, os.SEEK_END)
        archive_size = stream.tell() - tar_offset
        if archive_size < 0 or archive_size > MAX_ARCHIVE:
            fail("state restore archive exceeds limit", 22)
        records = scan_archive(stream, tar_offset, directories, {name for name, _required in managed})
        root_fd = open_absolute_dir(state_root)
        managed_state = validate_cleanup_targets(root_fd, directories, managed)
        clean_targets(root_fd, directories, managed, managed_state)
        extract_archive(stream, tar_offset, root_fd, records)
        verify_directories(root_fd, directories)
        verify_managed_extensions(root_fd, managed, managed_state)
    finally:
        stream.close()
        stream = None
finally:
    if stream is not None:
        stream.close()
    if root_fd is not None:
        os.close(root_fd)
    if payload_fd is not None:
        os.close(payload_fd)
    os.close(parent_fd)
print("RESTORE_OK")
`;
