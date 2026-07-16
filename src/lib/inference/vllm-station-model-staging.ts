// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { buildVllmSshTransportEnv } from "./vllm-docker-env";
import {
  DUAL_STATION_VLLM_RUNTIME,
  type DualStationVllmPlan,
  strictStationSshTransportArgs,
  validatePeerTarget,
} from "./vllm-station-cluster";

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const SNAPSHOT_AUDIT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RSYNC_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const RSYNC_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_POSIX_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export interface ModelStagingCommandOptions {
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  streamOutput?: boolean;
}

export interface ModelStagingCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

export interface DualStationModelStagingDeps {
  runCommand(
    file: string,
    args: readonly string[],
    options: ModelStagingCommandOptions,
  ): Promise<ModelStagingCommandResult>;
}

export type DualStationModelStagingResult =
  | { ok: true; transferred: boolean }
  | { ok: false; reason: string };

interface SnapshotManifest {
  schemaVersion: 1;
  files: Array<{ path: string; size: number; sha256: string }>;
  directories: string[];
  totalBytes: number;
}

interface StagingPaths {
  localModelRoot: string;
  localSnapshot: string;
  peerSnapshot: string;
  peerStaging: string;
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function defaultRunCommand(
  file: string,
  args: readonly string[],
  options: ModelStagingCommandOptions,
): Promise<ModelStagingCommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        env: options.env,
        shell: false,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: "", error: (err as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const absoluteTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    absoluteTimer.unref?.();

    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (options.idleTimeoutMs === undefined) return;
      idleTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdleTimer();

    child.stdout?.on("data", (value: Buffer | string) => {
      const chunk = String(value);
      stdout = appendBounded(stdout, chunk, MAX_MANIFEST_BYTES);
      resetIdleTimer();
      if (options.streamOutput) process.stdout.write(chunk);
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      const chunk = String(value);
      stderr = appendBounded(stderr, chunk, MAX_COMMAND_OUTPUT_BYTES);
      resetIdleTimer();
      if (options.streamOutput) process.stderr.write(chunk);
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ status: null, stdout, stderr, error: err.message, timedOut });
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

const defaultDeps: DualStationModelStagingDeps = { runCommand: defaultRunCommand };

function snapshotPath(home: string): string {
  return path.posix.join(
    home,
    ".cache",
    "huggingface",
    "hub",
    `models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
    "snapshots",
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
  );
}

function stagingTransactionId(plan: DualStationVllmPlan): string {
  const identity = [
    "nemoclaw-dual-station-model-staging-v1",
    DUAL_STATION_VLLM_RUNTIME.image,
    DUAL_STATION_VLLM_RUNTIME.modelId,
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
    DUAL_STATION_VLLM_RUNTIME.servedModelId,
    String(DUAL_STATION_VLLM_RUNTIME.tensorParallelSize),
    String(DUAL_STATION_VLLM_RUNTIME.nodeCount),
    plan.local.gpu.uuid,
    plan.peer.gpu.uuid,
  ].join("\0");
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
}

function stagingPaths(plan: DualStationVllmPlan): StagingPaths {
  for (const [label, home] of [
    ["local", plan.local.home],
    ["peer", plan.peer.home],
  ] as const) {
    if (
      !SAFE_POSIX_PATH_PATTERN.test(home) ||
      path.posix.normalize(home) !== home ||
      home.split("/").some((component) => component === "." || component === "..")
    ) {
      throw new Error(`${label} home is unsafe for model staging`);
    }
  }
  const validatedPeer = validatePeerTarget(plan.peerSshTarget);
  if (!validatedPeer.ok || validatedPeer.target !== plan.peerSshTarget) {
    throw new Error("peer SSH target is unsafe for model staging");
  }
  if (
    plan.runtime.modelId !== DUAL_STATION_VLLM_RUNTIME.modelId ||
    plan.runtime.modelRevision !== DUAL_STATION_VLLM_RUNTIME.modelRevision ||
    plan.runtime.image !== DUAL_STATION_VLLM_RUNTIME.image
  ) {
    throw new Error("dual-Station plan does not identify the pinned runtime");
  }

  const localSnapshot = snapshotPath(plan.local.home);
  const peerSnapshot = snapshotPath(plan.peer.home);
  return {
    localModelRoot: path.posix.dirname(path.posix.dirname(localSnapshot)),
    localSnapshot,
    peerSnapshot,
    peerStaging: path.posix.join(
      path.posix.dirname(peerSnapshot),
      `.nemoclaw-staging-${stagingTransactionId(plan)}`,
    ),
  };
}

const LOCAL_MANIFEST_SCRIPT = String.raw`
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

if len(sys.argv) != 3:
    raise SystemExit("expected snapshot and model-root paths")

snapshot = Path(sys.argv[1])
model_root = Path(sys.argv[2])
safe_component = re.compile(r"^[A-Za-z0-9._-]+$")

def relative_name(candidate):
    relative = candidate.relative_to(snapshot)
    if not relative.parts or any(not safe_component.fullmatch(part) for part in relative.parts):
        raise SystemExit("snapshot contains an unsafe relative path")
    return relative.as_posix()

def resolved_regular_file(candidate):
    metadata = candidate.lstat()
    resolved = candidate.resolve(strict=True) if stat.S_ISLNK(metadata.st_mode) else candidate
    try:
        common = os.path.commonpath((str(model_root.resolve(strict=True)), str(resolved.resolve(strict=True))))
    except (OSError, ValueError):
        raise SystemExit("snapshot file could not be resolved")
    if common != str(model_root.resolve(strict=True)):
        raise SystemExit("snapshot symlink escapes the pinned model cache")
    if not resolved.is_file():
        raise SystemExit("snapshot contains a non-regular file")
    return resolved

if snapshot.is_symlink() or not snapshot.is_dir():
    raise SystemExit("pinned local snapshot directory is missing or unsafe")
if model_root.is_symlink() or not model_root.is_dir():
    raise SystemExit("pinned local model cache root is missing or unsafe")

try:
    index = json.loads((snapshot / "model.safetensors.index.json").read_text(encoding="utf-8"))
    weight_map = index.get("weight_map", {})
    shards = sorted(set(weight_map.values())) if isinstance(weight_map, dict) else []
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit("pinned local weight index is missing or malformed")
if len(shards) != 113 or any(
    not isinstance(item, str)
    or Path(item).name != item
    or not safe_component.fullmatch(item)
    or not item.endswith(".safetensors")
    for item in shards
):
    raise SystemExit("pinned local weight index has an unexpected shard set")
if not (snapshot / "config.json").is_file():
    raise SystemExit("pinned local config.json is missing")
if not any((snapshot / name).is_file() for name in ("tokenizer.json", "tokenizer.model", "vocab.json")):
    raise SystemExit("pinned local tokenizer assets are missing")

files = []
directories = []
total_bytes = 0
entry_count = 0
for current, dirnames, filenames in os.walk(snapshot, topdown=True, followlinks=False):
    current_path = Path(current)
    dirnames.sort()
    filenames.sort()
    for dirname in dirnames:
        directory = current_path / dirname
        relative = relative_name(directory)
        mode = directory.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            raise SystemExit("snapshot contains an unsafe directory")
        directories.append(relative)
        entry_count += 1
    for filename in filenames:
        candidate = current_path / filename
        relative = relative_name(candidate)
        resolved = resolved_regular_file(candidate)
        digest = hashlib.sha256()
        size = 0
        with resolved.open("rb") as handle:
            for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
        files.append({"path": relative, "size": size, "sha256": digest.hexdigest()})
        total_bytes += size
        entry_count += 1
        if entry_count > 4096 or total_bytes > 1024 * 1024 * 1024 * 1024:
            raise SystemExit("snapshot exceeds the staging safety bounds")

if not files or any(not (snapshot / shard).exists() for shard in shards):
    raise SystemExit("pinned local snapshot is incomplete")
print(json.dumps({
    "schemaVersion": 1,
    "files": files,
    "directories": directories,
    "totalBytes": total_bytes,
}, separators=(",", ":")))
`;

function parseManifest(result: ModelStagingCommandResult): SnapshotManifest {
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new Error(commandFailure("local pinned snapshot audit", result));
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("local pinned snapshot manifest exceeded the safety bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("local pinned snapshot audit returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("local pinned snapshot audit returned an invalid manifest");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.directories) ||
    !Number.isSafeInteger(record.totalBytes) ||
    Number(record.totalBytes) <= 0 ||
    record.files.length === 0 ||
    record.files.length + record.directories.length > 4096
  ) {
    throw new Error("local pinned snapshot audit returned an invalid manifest");
  }
  const files = record.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("local pinned snapshot manifest contains an invalid file");
    }
    const file = value as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(file.path) ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("local pinned snapshot manifest contains an invalid file");
    }
    return { path: file.path, size: Number(file.size), sha256: file.sha256 };
  });
  const directories = record.directories.map((value) => {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error("local pinned snapshot manifest contains an invalid directory");
    }
    return value;
  });
  const filePaths = files.map((file) => file.path);
  if (
    new Set(filePaths).size !== files.length ||
    new Set(directories).size !== directories.length ||
    directories.some((directory) => filePaths.includes(directory)) ||
    files.reduce((total, file) => total + file.size, 0) !== Number(record.totalBytes)
  ) {
    throw new Error("local pinned snapshot manifest is internally inconsistent");
  }
  return {
    schemaVersion: 1,
    files,
    directories,
    totalBytes: Number(record.totalBytes),
  };
}

function remoteScript(
  plan: DualStationVllmPlan,
  paths: StagingPaths,
  manifest: SnapshotManifest,
  operation: "prepare" | "finalize",
): string {
  const manifestBase64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  return String.raw`
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

EXPECTED_HOME = Path(${JSON.stringify(plan.peer.home)})
FINAL = Path(${JSON.stringify(paths.peerSnapshot)})
STAGING = Path(${JSON.stringify(paths.peerStaging)})
OPERATION = ${JSON.stringify(operation)}
EXPECTED = json.loads(base64.b64decode(${JSON.stringify(manifestBase64)}, validate=True))
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")

def fail(message):
    raise SystemExit(message)

def relative_name(root, candidate):
    relative = candidate.relative_to(root)
    if not relative.parts or any(not SAFE_COMPONENT.fullmatch(part) for part in relative.parts):
        fail("peer snapshot contains an unsafe relative path")
    return relative.as_posix()

def manifest(root):
    if root.is_symlink() or not root.is_dir():
        fail("peer snapshot path is missing or unsafe")
    files = []
    directories = []
    total_bytes = 0
    entry_count = 0
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        dirnames.sort()
        filenames.sort()
        for dirname in dirnames:
            directory = current_path / dirname
            relative = relative_name(root, directory)
            mode = directory.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                fail("peer snapshot contains an unsafe directory")
            directories.append(relative)
            entry_count += 1
        for filename in filenames:
            candidate = current_path / filename
            relative = relative_name(root, candidate)
            mode = candidate.lstat().st_mode
            if not stat.S_ISREG(mode):
                fail("peer snapshot contains a symlink or non-regular file")
            digest = hashlib.sha256()
            size = 0
            with candidate.open("rb") as handle:
                for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
            files.append({"path": relative, "size": size, "sha256": digest.hexdigest()})
            total_bytes += size
            entry_count += 1
            if entry_count > 4096 or total_bytes > 1024 * 1024 * 1024 * 1024:
                fail("peer snapshot exceeds the staging safety bounds")
    return {"schemaVersion": 1, "files": files, "directories": directories, "totalBytes": total_bytes}

def path_exists(candidate):
    return os.path.lexists(candidate)

def verify_parent_chain():
    observed_home = Path.home()
    if observed_home != EXPECTED_HOME or EXPECTED_HOME.is_symlink() or not EXPECTED_HOME.is_dir():
        fail("peer home identity changed during model staging")
    current = EXPECTED_HOME
    relative_parent = FINAL.parent.relative_to(EXPECTED_HOME)
    for component in relative_parent.parts:
        if not SAFE_COMPONENT.fullmatch(component):
            fail("peer snapshot parent contains an unsafe component")
        current = current / component
        if path_exists(current):
            mode = current.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                fail("peer snapshot parent is a symlink or non-directory")
        else:
            current.mkdir(mode=0o700)

def verify_partial(root):
    if root.is_symlink() or not root.is_dir():
        fail("peer staging path is unsafe")
    expected_files = {item["path"]: item["size"] for item in EXPECTED["files"]}
    expected_directories = set(EXPECTED["directories"])
    entry_count = 0
    reusable_bytes = 0
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in sorted(dirnames):
            candidate = current_path / name
            relative = relative_name(root, candidate)
            mode = candidate.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode) or relative not in expected_directories:
                fail("peer staging path contains an unsafe entry")
            entry_count += 1
            if entry_count > 8192:
                fail("peer staging path exceeds the safety bound")
        for name in sorted(filenames):
            candidate = current_path / name
            relative = relative_name(root, candidate)
            mode = candidate.lstat().st_mode
            size = candidate.stat().st_size
            if (
                stat.S_ISLNK(mode)
                or not stat.S_ISREG(mode)
                or relative not in expected_files
                or size > expected_files[relative]
            ):
                fail("peer staging path contains an unsafe entry")
            reusable_bytes += size
            entry_count += 1
            if entry_count > 8192:
                fail("peer staging path exceeds the safety bound")
    return reusable_bytes

verify_parent_chain()
if OPERATION == "prepare":
    if path_exists(FINAL):
        if manifest(FINAL) != EXPECTED:
            fail("peer pinned snapshot already exists with different content")
        print(json.dumps({"state": "ready"}, separators=(",", ":")))
    else:
        if path_exists(STAGING):
            reusable_bytes = verify_partial(STAGING)
        else:
            STAGING.mkdir(mode=0o700)
            reusable_bytes = 0
        remaining_bytes = max(0, EXPECTED["totalBytes"] - reusable_bytes)
        headroom_bytes = max(5 * 1024 * 1024 * 1024, EXPECTED["totalBytes"] // 20)
        if shutil.disk_usage(STAGING.parent).free < remaining_bytes + headroom_bytes:
            fail("peer model cache does not have enough free space for the pinned snapshot")
        print(json.dumps({"state": "transfer"}, separators=(",", ":")))
elif OPERATION == "finalize":
    if path_exists(FINAL):
        if manifest(FINAL) != EXPECTED:
            fail("peer pinned snapshot appeared with different content")
        if path_exists(STAGING):
            verify_partial(STAGING)
            shutil.rmtree(STAGING)
    else:
        if manifest(STAGING) != EXPECTED:
            fail("peer staged snapshot failed byte-integrity verification")
        staged_identity = (STAGING.stat().st_dev, STAGING.stat().st_ino)
        os.rename(STAGING, FINAL)
        installed_identity = (FINAL.stat().st_dev, FINAL.stat().st_ino)
        if installed_identity != staged_identity:
            fail("peer pinned snapshot identity changed during atomic install")
    print(json.dumps({"state": "ready"}, separators=(",", ":")))
else:
    fail("unsupported model staging operation")
`;
}

function commandFailure(label: string, result: ModelStagingCommandResult): string {
  if (result.timedOut) return `${label} timed out`;
  const detail = (
    result.error ||
    result.stderr.trim().split("\n").at(-1) ||
    "command failed"
  ).slice(0, 512);
  return `${label} failed: ${detail}`;
}

function parseRemoteState(
  label: string,
  result: ModelStagingCommandResult,
  expected: "ready" | "transfer",
): void {
  if (result.status !== 0 || result.timedOut || result.error) {
    throw new Error(commandFailure(label, result));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).state !== expected
  ) {
    throw new Error(`${label} returned an unexpected state`);
  }
}

function sshArgs(plan: DualStationVllmPlan): string[] {
  return [...strictStationSshTransportArgs(), "--", plan.peerSshTarget, "python3 -"];
}

function rsyncRsh(): string {
  return ["ssh", ...strictStationSshTransportArgs()].join(" ");
}

/**
 * Materialize only the pinned snapshot on the pre-trusted peer. Hugging Face
 * snapshot symlinks are copied as regular files after an escape check, so no
 * token or unrelated blob cache crosses the SSH boundary.
 */
export async function stageDualStationModelSnapshot(
  plan: DualStationVllmPlan,
  deps: DualStationModelStagingDeps = defaultDeps,
): Promise<DualStationModelStagingResult> {
  let paths: StagingPaths;
  try {
    paths = stagingPaths(plan);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const env = buildVllmSshTransportEnv({ LC_ALL: "C" });

  let manifest: SnapshotManifest;
  try {
    const audit = await deps.runCommand(
      "python3",
      ["-", paths.localSnapshot, paths.localModelRoot],
      {
        env,
        input: LOCAL_MANIFEST_SCRIPT,
        timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
      },
    );
    manifest = parseManifest(audit);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const prepare = await deps.runCommand("ssh", sshArgs(plan), {
    env,
    input: remoteScript(plan, paths, manifest, "prepare"),
    timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
  });
  try {
    if (prepare.status === 0 && JSON.parse(prepare.stdout.trim()).state === "ready") {
      parseRemoteState("peer snapshot preflight", prepare, "ready");
      return { ok: true, transferred: false };
    }
    parseRemoteState("peer snapshot preflight", prepare, "transfer");
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const rsync = await deps.runCommand(
    "rsync",
    [
      "--recursive",
      "--times",
      "--copy-links",
      "--checksum",
      "--partial",
      "--protect-args",
      "--no-owner",
      "--no-group",
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      "--info=progress2",
      `--rsh=${rsyncRsh()}`,
      "--",
      `${paths.localSnapshot}/`,
      `${plan.peerSshTarget}:${paths.peerStaging}/`,
    ],
    {
      env,
      timeoutMs: RSYNC_TIMEOUT_MS,
      idleTimeoutMs: RSYNC_IDLE_TIMEOUT_MS,
      streamOutput: true,
    },
  );
  if (rsync.status !== 0 || rsync.timedOut || rsync.error) {
    return { ok: false, reason: commandFailure("peer snapshot transfer", rsync) };
  }

  const finalize = await deps.runCommand("ssh", sshArgs(plan), {
    env,
    input: remoteScript(plan, paths, manifest, "finalize"),
    timeoutMs: SNAPSHOT_AUDIT_TIMEOUT_MS,
  });
  try {
    parseRemoteState("peer snapshot verification", finalize, "ready");
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true, transferred: true };
}
