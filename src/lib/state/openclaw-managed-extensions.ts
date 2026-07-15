// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { listOpenClawPluginExtensionIds } from "../messaging/channels/metadata.js";

// Exact symlinks baked into OpenClaw messaging images at build time. Source
// paths are relative to the agent state-dir root (e.g. /sandbox/.openclaw);
// targets are matched exactly against `readlink(source)`.
const AUDIT_SYMLINK_WHITELIST: ReadonlyMap<string, string> = new Map([
  [
    "extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal",
    "../qrcode-terminal/bin/qrcode-terminal.js",
  ],
]);

const EXTENSION_NPM_BIN_RE = /^extensions\/[A-Za-z0-9][A-Za-z0-9._-]*\/node_modules\/\.bin\/[^/]+$/;
// `openclaw plugins install <archive>` creates this peer-dependency link for
// each extension. Match both the narrow path shape and the immutable image
// target; source-only matching would permit repointing it to an arbitrary file.
const OPENCLAW_EXTENSION_PEER_LINK_RE =
  /^extensions\/[A-Za-z0-9][A-Za-z0-9._-]*\/node_modules\/openclaw$/;
const OPENCLAW_GLOBAL_PACKAGE_PATH = "/usr/local/lib/node_modules/openclaw";

// Preserve extensions baked into the freshly rebuilt image instead of
// replacing them with archived copies. Messaging IDs come from the reviewed
// channel manifests; the remaining entries are installed by Dockerfile.base.
export const OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS = [
  "nemoclaw",
  "diagnostics-otel",
  "brave",
  ...listOpenClawPluginExtensionIds(),
] as const;

interface OpenClawRestoreManifest {
  readonly agentType: string;
}

function isAllowedExtensionNpmBinSymlink(relPath: string, linkTarget: string): boolean {
  const normalizedRelPath = relPath.split(path.sep).join("/");
  if (!EXTENSION_NPM_BIN_RE.test(normalizedRelPath)) return false;
  if (linkTarget.length === 0 || linkTarget.includes("%") || path.posix.isAbsolute(linkTarget)) {
    return false;
  }

  const binDir = path.posix.dirname(normalizedRelPath);
  const nodeModulesDir = path.posix.dirname(binDir);
  const resolvedTarget = path.posix.normalize(path.posix.join(binDir, linkTarget));
  const targetWithinNodeModules = path.posix.relative(nodeModulesDir, resolvedTarget);

  return (
    targetWithinNodeModules.length > 0 &&
    targetWithinNodeModules !== ".." &&
    !targetWithinNodeModules.startsWith("../") &&
    !path.posix.isAbsolute(targetWithinNodeModules) &&
    !targetWithinNodeModules.startsWith(".bin/")
  );
}

function isAllowedOpenClawExtensionPeerSymlink(relPath: string, linkTarget: string): boolean {
  const normalizedRelPath = relPath.split(path.sep).join("/");
  return (
    OPENCLAW_EXTENSION_PEER_LINK_RE.test(normalizedRelPath) &&
    linkTarget === OPENCLAW_GLOBAL_PACKAGE_PATH
  );
}

export function isAllowedStateSymlink(relPath: string, linkTarget: string): boolean {
  const exactTarget = AUDIT_SYMLINK_WHITELIST.get(relPath.split(path.sep).join("/"));
  if (exactTarget !== undefined) return exactTarget === linkTarget;
  return (
    isAllowedOpenClawExtensionPeerSymlink(relPath, linkTarget) ||
    isAllowedExtensionNpmBinSymlink(relPath, linkTarget)
  );
}

export function shouldPreserveOpenClawManagedExtensions(
  manifest: OpenClawRestoreManifest,
  dir: string,
  localDirs: readonly string[],
): boolean {
  return (
    localDirs.includes("extensions") &&
    (manifest.agentType === "openclaw" || dir.replace(/\/+$/, "") === "/sandbox/.openclaw")
  );
}
