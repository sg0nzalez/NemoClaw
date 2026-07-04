// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dockerInfoFormat } from "../adapters/docker";
import { ROOT } from "../runner";
import {
  OPENSHELL_SANDBOX_MIN_GLIBC,
  type ResolveBaseImageOptions,
  SANDBOX_BASE_RESOLUTION_SCHEMA,
} from "./types";

export type SandboxBaseImageResolutionKeySources = {
  getSourceShortShaTags: (rootDir: string, env: NodeJS.ProcessEnv) => string[];
  getVersionedBaseImageTags: (rootDir: string, env: NodeJS.ProcessEnv) => string[];
  normalizeBaseImageInputPaths: (rootDir: string, paths: string[]) => string[];
};

function hashBaseImageInputs(
  rootDir: string,
  dockerfilePath: string,
  sources: SandboxBaseImageResolutionKeySources,
): string {
  const hash = crypto.createHash("sha256");
  const paths = sources.normalizeBaseImageInputPaths(rootDir, [dockerfilePath]).sort();
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

export function createSandboxBaseImageResolutionKey(
  options: ResolveBaseImageOptions,
  sources: SandboxBaseImageResolutionKeySources,
): string {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT;
  const override = options.envVar ? String(env[options.envVar] || "").trim() : "";
  const material = {
    schema: SANDBOX_BASE_RESOLUTION_SCHEMA,
    imageName: options.imageName,
    override,
    versionTags: sources.getVersionedBaseImageTags(rootDir, env),
    sourceTags: sources.getSourceShortShaTags(rootDir, env),
    localTag: options.localTag,
    inputFingerprint: hashBaseImageInputs(rootDir, options.dockerfilePath, sources),
    platform: dockerPlatform(),
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
