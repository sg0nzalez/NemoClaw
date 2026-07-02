// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  dockerBuild,
  dockerCapture,
  dockerImageInspect,
  dockerImageInspectFormat,
  dockerInfoFormat,
  dockerPull,
} from "./adapters/docker";
import { ROOT, redact } from "./runner";
import { addTraceEvent } from "./trace";

export const OPENCLAW_SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
export const SANDBOX_BASE_TAG = "latest";
export const OPENSHELL_SANDBOX_MIN_GLIBC = "2.39";

export const SANDBOX_BASE_RESOLUTION_LABEL = "com.nvidia.nemoclaw.base-resolution";
export const SANDBOX_BASE_RESOLUTION_KEY_LABEL = "com.nvidia.nemoclaw.base-resolution-key";
const SANDBOX_BASE_RESOLUTION_SCHEMA = 1;

export type SandboxBaseImageResolutionMetadata = {
  schema: number;
  key: string;
  imageName: string;
  ref: string;
  digest: string | null;
  source: SandboxBaseImageResolution["source"];
  imageId: string;
  os: string;
  architecture: string;
  glibcVersion: string | null;
  requireOpenshellSandboxAbi: boolean;
  minGlibcVersion: string;
};

export type ResolveBaseImageOptions = {
  imageName: string;
  dockerfilePath: string;
  localTag: string;
  envVar?: string;
  label?: string;
  requireOpenshellSandboxAbi?: boolean;
  minGlibcVersion?: string;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceRefresh?: boolean;
};

export type SandboxBaseImageResolution = {
  ref: string;
  digest: string | null;
  source: "override" | "version-tag" | "source-sha" | "latest" | "local";
  glibcVersion: string | null;
  metadata?: SandboxBaseImageResolutionMetadata;
};

const BASE_IMAGE_INPUT_PATHS = ["Dockerfile.base", "nemoclaw-blueprint/blueprint.yaml"];

export type LocalImageMetadata = {
  Id?: unknown;
  RepoDigests?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Labels?: unknown } | null;
};

export type BaseImageResolutionValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "key_mismatch"
        | "requirements_changed"
        | "abi_incompatible"
        | "local_image_changed"
        | "repo_digest_missing";
    };

export function validateSandboxBaseImageResolutionMetadata(input: {
  metadata: SandboxBaseImageResolutionMetadata;
  expectedKey: string;
  imageName: string;
  requireOpenshellSandboxAbi: boolean;
  minGlibcVersion: string;
  inspected: LocalImageMetadata | null;
}): BaseImageResolutionValidation {
  const { metadata, inspected } = input;
  if (metadata.key !== input.expectedKey || metadata.imageName !== input.imageName) {
    return { ok: false, reason: "key_mismatch" };
  }
  if (
    metadata.requireOpenshellSandboxAbi !== input.requireOpenshellSandboxAbi ||
    metadata.minGlibcVersion !== input.minGlibcVersion
  ) {
    return { ok: false, reason: "requirements_changed" };
  }
  if (
    input.requireOpenshellSandboxAbi &&
    (!metadata.glibcVersion || !versionGte(metadata.glibcVersion, input.minGlibcVersion))
  ) {
    return { ok: false, reason: "abi_incompatible" };
  }
  if (
    !inspected ||
    inspected.Id !== metadata.imageId ||
    inspected.Os !== metadata.os ||
    inspected.Architecture !== metadata.architecture
  ) {
    return { ok: false, reason: "local_image_changed" };
  }
  if (metadata.digest) {
    const expectedRepoDigest = `${input.imageName}@${metadata.digest}`;
    const repoDigests = Array.isArray(inspected.RepoDigests) ? inspected.RepoDigests : [];
    if (!repoDigests.some((entry) => String(entry) === expectedRepoDigest)) {
      return { ok: false, reason: "repo_digest_missing" };
    }
  }
  return { ok: true };
}

function inspectLocalImageMetadata(imageRef: string): LocalImageMetadata | null {
  const output = dockerImageInspectFormat("{{json .}}", imageRef, {
    ignoreError: true,
  });
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as LocalImageMetadata) : null;
  } catch {
    return null;
  }
}

function hashBaseImageInputs(rootDir: string, dockerfilePath: string): string {
  const hash = crypto.createHash("sha256");
  const paths = normalizeBaseImageInputPaths(rootDir, [dockerfilePath]).sort();
  for (const relativePath of paths) {
    hash.update(relativePath);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(path.join(rootDir, relativePath)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function dockerPlatform(): string {
  const reported = dockerInfoFormat("{{.OSType}}/{{.Architecture}}", {
    ignoreError: true,
    timeout: 5_000,
  }).trim();
  return reported && reported !== "/" ? reported : `${process.platform}/${process.arch}`;
}

export function createSandboxBaseImageResolutionKey(options: ResolveBaseImageOptions): string {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT;
  const override = options.envVar ? String(env[options.envVar] || "").trim() : "";
  const material = {
    schema: SANDBOX_BASE_RESOLUTION_SCHEMA,
    imageName: options.imageName,
    override,
    versionTags: getVersionedBaseImageTags(rootDir, env),
    sourceTags: getSourceShortShaTags(rootDir, env),
    localTag: options.localTag,
    inputFingerprint: hashBaseImageInputs(rootDir, options.dockerfilePath),
    platform: dockerPlatform(),
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function readSandboxBaseImageResolutionMetadata(
  sandboxImageRef: string | null | undefined,
): SandboxBaseImageResolutionMetadata | null {
  if (!sandboxImageRef) return null;
  const labelsOutput = dockerImageInspectFormat("{{json .Config.Labels}}", sandboxImageRef, {
    ignoreError: true,
  });
  if (!labelsOutput) return null;
  try {
    return parseSandboxBaseImageResolutionLabels(JSON.parse(labelsOutput));
  } catch {
    return null;
  }
}

export function parseSandboxBaseImageResolutionLabels(
  labels: unknown,
): SandboxBaseImageResolutionMetadata | null {
  try {
    if (!labels || typeof labels !== "object") return null;
    const encoded = (labels as Record<string, unknown>)[SANDBOX_BASE_RESOLUTION_LABEL];
    if (typeof encoded !== "string" || !encoded) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const metadata = parsed as SandboxBaseImageResolutionMetadata;
    const validSources = new Set<SandboxBaseImageResolution["source"]>([
      "override",
      "version-tag",
      "source-sha",
      "latest",
      "local",
    ]);
    if (
      metadata.schema !== SANDBOX_BASE_RESOLUTION_SCHEMA ||
      typeof metadata.key !== "string" ||
      typeof metadata.imageName !== "string" ||
      typeof metadata.ref !== "string" ||
      (metadata.digest !== null && typeof metadata.digest !== "string") ||
      !validSources.has(metadata.source) ||
      typeof metadata.imageId !== "string" ||
      typeof metadata.os !== "string" ||
      typeof metadata.architecture !== "string" ||
      (metadata.glibcVersion !== null && typeof metadata.glibcVersion !== "string") ||
      typeof metadata.requireOpenshellSandboxAbi !== "boolean" ||
      typeof metadata.minGlibcVersion !== "string"
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

export function formatSandboxBaseImageResolutionLabels(
  metadata: SandboxBaseImageResolutionMetadata | null | undefined,
): string {
  if (!metadata) return "";
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return (
    `LABEL ${SANDBOX_BASE_RESOLUTION_KEY_LABEL}=${JSON.stringify(metadata.key)} ` +
    `${SANDBOX_BASE_RESOLUTION_LABEL}=${JSON.stringify(encoded)}`
  );
}

function normalizeBaseImageInputPaths(rootDir: string, paths: string[] = []): string[] {
  const absoluteRootDir = path.resolve(rootDir);
  const normalizedPaths = paths
    .map((inputPath) => {
      const trimmed = String(inputPath || "").trim();
      if (!trimmed) return null;
      const absolutePath = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(absoluteRootDir, trimmed);
      const relativePath = path.relative(absoluteRootDir, absolutePath);
      if (
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      return relativePath.split(path.sep).join("/");
    })
    .filter((inputPath): inputPath is string => !!inputPath);
  return Array.from(new Set([...BASE_IMAGE_INPUT_PATHS, ...normalizedPaths]));
}

/**
 * Combine stderr + stdout from a captured `dockerBuild` failure and pass them
 * through the runner's redaction so secrets in build output never reach the
 * terminal. BuildKit splits diagnostics across both streams depending on the
 * backend and progress mode, so taking only stderr can hide the actual reason
 * a build failed.
 */
export function formatBuildFailureDiagnostics(buildResult: {
  stderr?: unknown;
  stdout?: unknown;
}): string {
  const streams = [buildResult.stderr, buildResult.stdout]
    .map((stream) => {
      if (stream == null) return "";
      if (Buffer.isBuffer(stream)) return stream.toString("utf8");
      return String(stream);
    })
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return streams.length > 0 ? redact(streams.join("\n")) : "";
}

export function parseGlibcVersion(output: string | null | undefined): string | null {
  const text = String(output || "");
  const match =
    text.match(/GLIBC\s+([0-9]+(?:\.[0-9]+)+)/i) || text.match(/\s([0-9]+\.[0-9]+)\s*$/);
  return match ? match[1] : null;
}

export function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function getImageGlibcVersion(imageRef: string): string | null {
  const output = dockerCapture(
    ["run", "--rm", "--entrypoint", "/usr/bin/ldd", imageRef, "--version"],
    { ignoreError: true, timeout: 20_000 },
  );
  return parseGlibcVersion(output);
}

export function imageMeetsMinimumGlibc(
  imageRef: string,
  minVersion = OPENSHELL_SANDBOX_MIN_GLIBC,
): {
  ok: boolean;
  version: string | null;
} {
  const version = getImageGlibcVersion(imageRef);
  return { ok: !!version && versionGte(version, minVersion), version };
}

export function getSourceShortShaTags(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values: string[] = [];
  const push = (value: string | null | undefined) => {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(normalized)) return;
    values.push(normalized.slice(0, 8), normalized.slice(0, 7));
  };

  push(env.GITHUB_SHA);
  const git = spawnSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (git.status === 0) push(git.stdout);

  return Array.from(new Set(values));
}

function normalizeVersionTag(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw || raw === "latest") return null;
  const withoutPrefix = raw.replace(/^refs\/tags\//, "").replace(/^release\//, "");
  const version = withoutPrefix.startsWith("v") ? withoutPrefix.slice(1) : withoutPrefix;
  if (!/^[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    return null;
  }
  return `v${version}`;
}

function gitExactVersionTag(rootDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const git = spawnSync(
    "git",
    ["-C", rootDir, "describe", "--tags", "--exact-match", "--match", "v*"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env,
    },
  );
  return git.status === 0 ? normalizeVersionTag(git.stdout) : null;
}

function versionFileTag(rootDir: string): string | null {
  try {
    return normalizeVersionTag(fs.readFileSync(path.join(rootDir, ".version"), "utf-8"));
  } catch {
    return null;
  }
}

export function getVersionedBaseImageTags(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = [
    env.NEMOCLAW_SANDBOX_BASE_VERSION_TAG,
    env.NEMOCLAW_INSTALL_REF,
    env.NEMOCLAW_INSTALL_TAG,
    env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : null,
    gitExactVersionTag(rootDir, env),
    versionFileTag(rootDir),
  ];
  return Array.from(
    new Set(values.map((value) => normalizeVersionTag(value)).filter(Boolean)),
  ) as string[];
}

function gitStatus(
  rootDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const git = spawnSync("git", ["-C", rootDir, ...args], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: 5_000,
    env,
  });
  return git.status;
}

function gitRefExists(rootDir: string, ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return gitStatus(rootDir, ["rev-parse", "--verify", `${ref}^{commit}`], env) === 0;
}

function gitFetchRemoteBranch(
  rootDir: string,
  remote: string,
  branch: string,
  localRef: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const normalizedBranch = String(branch || "").trim();
  if (!normalizedBranch) return;

  spawnSync(
    "git",
    [
      "-C",
      rootDir,
      "fetch",
      "--no-tags",
      "--depth=1",
      remote,
      `+refs/heads/${normalizedBranch}:${localRef}`,
    ],
    {
      encoding: "utf-8",
      stdio: "ignore",
      timeout: 30_000,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
}

function gitHasPathDiff(
  rootDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  inputPaths = BASE_IMAGE_INPUT_PATHS,
): boolean | null {
  const status = gitStatus(rootDir, [...args, "--", ...inputPaths], env);
  if (status === 0) return false;
  if (status === 1) return true;
  return null;
}

export function baseImageInputsChangedSinceMain(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
  paths: string[] = [],
): boolean {
  const inputPaths = normalizeBaseImageInputPaths(rootDir, paths);
  const worktreeDiff = gitHasPathDiff(rootDir, ["diff", "--quiet"], env, inputPaths);
  if (worktreeDiff === true) return true;

  const stagedDiff = gitHasPathDiff(rootDir, ["diff", "--cached", "--quiet"], env, inputPaths);
  if (stagedDiff === true) return true;

  const baseBranch = String(env.GITHUB_BASE_REF || "main").trim() || "main";
  const baseRemoteRef = `origin/${baseBranch}`;
  if (!gitRefExists(rootDir, baseRemoteRef, env)) {
    gitFetchRemoteBranch(rootDir, "origin", baseBranch, `refs/remotes/origin/${baseBranch}`, env);
  }

  const candidates = [baseRemoteRef, "origin/main", "upstream/main", "main"].filter(
    (ref): ref is string => !!ref,
  );

  for (const ref of Array.from(new Set(candidates))) {
    if (!gitRefExists(rootDir, ref, env)) continue;
    const diff = gitHasPathDiff(rootDir, ["diff", "--quiet", ref, "HEAD"], env, inputPaths);
    if (diff != null) return diff;
  }

  return false;
}

function localBuildAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD || "auto")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return env.NODE_ENV !== "test" && env.VITEST !== "true";
}

function getRepoDigest(
  imageName: string,
  imageRef: string,
): { digest: string; ref: string } | null {
  const atIndex = imageRef.indexOf("@sha256:");
  if (atIndex !== -1) {
    const digest = imageRef.slice(atIndex + 1);
    return { digest, ref: imageRef };
  }

  const inspectOutput = dockerImageInspectFormat("{{json .RepoDigests}}", imageRef, {
    ignoreError: true,
  });
  if (!inspectOutput) return null;

  let repoDigests: unknown;
  try {
    repoDigests = JSON.parse(inspectOutput || "[]");
  } catch {
    return null;
  }
  const repoDigest = Array.isArray(repoDigests)
    ? repoDigests.find((entry) => String(entry).startsWith(`${imageName}@sha256:`))
    : null;
  if (!repoDigest) return null;
  const digest = String(repoDigest).slice(String(repoDigest).indexOf("@") + 1);
  return { digest, ref: `${imageName}@${digest}` };
}

function createResolutionMetadata(
  options: ResolveBaseImageOptions,
  key: string,
  resolution: SandboxBaseImageResolution,
): SandboxBaseImageResolutionMetadata | null {
  // Published images must retain repository-digest proof. A mutable tag with
  // no RepoDigests entry remains usable for the current run, but is never
  // recorded as a warm-resolution hint. Local fallback images use image ID
  // plus the resolution key's input fingerprint instead.
  if (!resolution.digest && resolution.source !== "local") return null;
  const inspected = inspectLocalImageMetadata(resolution.ref);
  const imageId = typeof inspected?.Id === "string" ? inspected.Id : "";
  const osName = typeof inspected?.Os === "string" ? inspected.Os : "";
  const architecture = typeof inspected?.Architecture === "string" ? inspected.Architecture : "";
  if (!imageId || !osName || !architecture) return null;

  if (resolution.digest) {
    const expectedRepoDigest = `${options.imageName}@${resolution.digest}`;
    const repoDigests = Array.isArray(inspected?.RepoDigests) ? inspected.RepoDigests : [];
    if (!repoDigests.some((entry) => String(entry) === expectedRepoDigest)) return null;
  }

  return {
    schema: SANDBOX_BASE_RESOLUTION_SCHEMA,
    key,
    imageName: options.imageName,
    ref: resolution.ref,
    digest: resolution.digest,
    source: resolution.source,
    imageId,
    os: osName,
    architecture,
    glibcVersion: resolution.glibcVersion,
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
  };
}

function finalizeResolution(
  options: ResolveBaseImageOptions,
  key: string,
  resolution: SandboxBaseImageResolution,
): SandboxBaseImageResolution {
  const metadata = createResolutionMetadata(options, key, resolution);
  return metadata ? { ...resolution, metadata } : resolution;
}

function reuseResolutionHint(
  options: ResolveBaseImageOptions,
  key: string,
): SandboxBaseImageResolution | null {
  const hint = options.resolutionHint;
  if (!hint) return null;
  const validation = validateSandboxBaseImageResolutionMetadata({
    metadata: hint,
    expectedKey: key,
    imageName: options.imageName,
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
    inspected: inspectLocalImageMetadata(hint.ref),
  });
  if (!validation.ok) {
    addTraceEvent("nemoclaw.sandbox_base_image.cache_stale", { reason: validation.reason });
    return null;
  }

  addTraceEvent("nemoclaw.sandbox_base_image.cache_hit", {
    source: hint.source,
    digest_pinned: hint.digest !== null,
  });
  console.log(`  Reusing locally validated ${options.label || "sandbox base image"}: ${hint.ref}`);
  return {
    ref: hint.ref,
    digest: hint.digest,
    source: hint.source,
    glibcVersion: hint.glibcVersion,
    metadata: hint,
  };
}

function resolvePulledCandidate(
  imageName: string,
  imageRef: string,
  source: SandboxBaseImageResolution["source"],
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const inspectResult = dockerImageInspect(imageRef, {
    ignoreError: true,
    suppressOutput: true,
  });
  addTraceEvent("nemoclaw.sandbox_base_image.local_validation", {
    source,
    present: inspectResult.status === 0,
  });
  if (inspectResult.status !== 0) {
    addTraceEvent("nemoclaw.sandbox_base_image.remote_pull", { source });
    const pullResult = dockerPull(imageRef, { ignoreError: true, suppressOutput: true });
    if (pullResult.status !== 0) return null;
  }

  let glibcVersion: string | null = null;
  if (options.requireOpenshellSandboxAbi) {
    const check = imageMeetsMinimumGlibc(
      imageRef,
      options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
    );
    glibcVersion = check.version;
    if (!check.ok) {
      console.warn(
        `  Warning: ${options.label || "sandbox base image"} ${imageRef} has glibc ` +
          `${glibcVersion || "unknown"}; OpenShell sandbox supervisor requires ` +
          `glibc >= ${options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC}.`,
      );
      return null;
    }
  }

  const repoDigest = getRepoDigest(imageName, imageRef);
  return {
    ref: repoDigest?.ref || imageRef,
    digest: repoDigest?.digest || null,
    source,
    glibcVersion,
  };
}

function resolveLocalCandidate(
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const imageRef = options.localTag;
  const inspectResult = dockerImageInspect(imageRef, { ignoreError: true, suppressOutput: true });
  if (inspectResult.status === 0) {
    const check = options.requireOpenshellSandboxAbi
      ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
      : { ok: true, version: null };
    if (check.ok) {
      addTraceEvent("nemoclaw.sandbox_base_image.local_fallback_reuse");
      return { ref: imageRef, digest: null, source: "local", glibcVersion: check.version };
    }
  }

  if (!localBuildAllowed(options.env)) return null;

  const label = options.label || "sandbox base image";
  console.warn(`  Building ${label} locally because no compatible published base image was found.`);
  addTraceEvent("nemoclaw.sandbox_base_image.local_fallback_build");
  console.warn("  This is a one-time step and can take several minutes.");
  // Suppress the full BuildKit log (apt-get output, layer hashes, debconf
  // warnings) on success — same approach as #3311 for the [2/8] gateway
  // setup leak. `--quiet` collapses normal output to just the image hash;
  // `suppressOutput` keeps captured stdio out of the user's terminal.
  // On failure, surface the captured stderr so the user still gets a
  // useful diagnostic.
  const buildResult = dockerBuild(options.dockerfilePath, imageRef, options.rootDir || ROOT, {
    quiet: true,
    ignoreError: true,
    suppressOutput: true,
  });
  if (buildResult.error || buildResult.status !== 0) {
    const diagnostics = formatBuildFailureDiagnostics(buildResult);
    if (diagnostics) console.error(diagnostics);
    const detail = buildResult.error
      ? `: ${buildResult.error.message}`
      : ` (exit ${buildResult.status ?? "unknown"})`;
    console.error(`  Failed to build ${label}${detail}`);
    return null;
  }

  const check = options.requireOpenshellSandboxAbi
    ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
    : { ok: true, version: null };
  if (!check.ok) {
    console.error(
      `  Local ${label} ${imageRef} has glibc ` +
        `${check.version || "unknown"}; expected >= ` +
        `${options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC}.`,
    );
    return null;
  }

  return { ref: imageRef, digest: null, source: "local", glibcVersion: check.version };
}

export function resolveSandboxBaseImage(
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const env = options.env || process.env;
  const resolutionKey = createSandboxBaseImageResolutionKey(options);
  const override = options.envVar ? String(env[options.envVar] || "").trim() : "";

  if (!options.forceRefresh) {
    const reused = reuseResolutionHint(options, resolutionKey);
    if (reused) return reused;
  } else {
    addTraceEvent("nemoclaw.sandbox_base_image.force_refresh");
  }
  addTraceEvent("nemoclaw.sandbox_base_image.cache_miss", {
    has_hint: options.resolutionHint != null,
  });

  const finish = (resolution: SandboxBaseImageResolution): SandboxBaseImageResolution =>
    finalizeResolution(options, resolutionKey, resolution);

  if (override) {
    const resolved = resolvePulledCandidate(options.imageName, override, "override", options);
    if (resolved) return finish(resolved);
    if (!options.requireOpenshellSandboxAbi) return null;
  } else {
    for (const tag of getVersionedBaseImageTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "version-tag", options);
      if (resolved) return finish(resolved);
    }

    for (const tag of getSourceShortShaTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "source-sha", options);
      if (resolved) return finish(resolved);
    }

    if (baseImageInputsChangedSinceMain(options.rootDir || ROOT, env, [options.dockerfilePath])) {
      const local = resolveLocalCandidate(options);
      if (local) return finish(local);
      // The base Dockerfile changed, so fail closed instead of silently using stale :latest.
      return finish({
        ref: options.localTag,
        digest: null,
        source: "local",
        glibcVersion: null,
      });
    }

    const latestRef = `${options.imageName}:${SANDBOX_BASE_TAG}`;
    const resolved = resolvePulledCandidate(options.imageName, latestRef, "latest", options);
    if (resolved) return finish(resolved);
  }

  if (options.requireOpenshellSandboxAbi) {
    const local = resolveLocalCandidate(options);
    return local ? finish(local) : null;
  }
  return null;
}

export function buildLocalBaseTag(prefix: string, rootDir = ROOT, env = process.env): string {
  const tag = getSourceShortShaTags(rootDir, env)[0] || "local";
  return `${prefix}:${tag}`;
}

export function defaultOpenclawBaseDockerfile(rootDir = ROOT): string {
  return path.join(rootDir, "Dockerfile.base");
}
