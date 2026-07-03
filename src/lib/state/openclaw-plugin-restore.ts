// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { isRecord } from "../core/json-types.js";

const MAX_OPENCLAW_IMAGE_MANAGED_PLUGIN_INSTALLS = 128;
const OPENCLAW_EXTENSION_GLOB_CHARS = ["/", "\\", "*", "?", "[", "]"] as const;

export type OpenClawManagedExtensionDiscoveryResult =
  | { ok: true; extensionDirs: string[] }
  | { ok: false; error: string };

function isSafeOpenClawPluginInstallId(id: string): boolean {
  if (id.length === 0 || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) return false;
  const slash = id.indexOf("/");
  if (slash === -1) return true;
  return id.startsWith("@") && slash > 1 && slash === id.lastIndexOf("/") && slash < id.length - 1;
}

export function isSafeOpenClawExtensionDirName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name !== "." &&
    name !== ".." &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    !OPENCLAW_EXTENSION_GLOB_CHARS.some((char) => name.includes(char))
  );
}

export function parseFreshOpenClawPluginExtensionDirs(
  registryIndex: unknown,
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  if (!isRecord(registryIndex) || registryIndex.version !== 1) {
    return { ok: false, error: "fresh OpenClaw plugin install registry is invalid" };
  }
  const installs = registryIndex.installRecords;
  if (!isRecord(installs)) {
    return { ok: false, error: "fresh OpenClaw plugin install records are invalid" };
  }

  const ids = Object.keys(installs).sort();
  if (ids.length > MAX_OPENCLAW_IMAGE_MANAGED_PLUGIN_INSTALLS) {
    return {
      ok: false,
      error: `fresh OpenClaw registry has too many plugin installs (${ids.length})`,
    };
  }
  const extensionsDir = `${dir.replace(/\/+$/, "")}/extensions`;
  const extensionDirs = new Set<string>();
  for (const id of ids) {
    if (!isSafeOpenClawPluginInstallId(id)) {
      return { ok: false, error: `fresh OpenClaw registry has unsafe plugin install id: ${id}` };
    }
    const install = installs[id];
    if (!isRecord(install)) {
      return { ok: false, error: `fresh OpenClaw plugin install metadata is invalid: ${id}` };
    }
    if (typeof install.installPath !== "string" || !path.posix.isAbsolute(install.installPath)) {
      return { ok: false, error: `fresh OpenClaw plugin install path is invalid for ${id}` };
    }
    const normalizedInstallPath = path.posix.normalize(install.installPath);
    if (normalizedInstallPath !== install.installPath) {
      return { ok: false, error: `fresh OpenClaw plugin install path is invalid for ${id}` };
    }

    // npm-origin installs legitimately live under .openclaw/npm/node_modules
    // and are not part of the backed-up extensions directory. Only direct
    // children of extensions can be overwritten by extension restore.
    const relativeInstallPath = path.posix.relative(extensionsDir, normalizedInstallPath);
    if (
      relativeInstallPath.startsWith("../") ||
      relativeInstallPath === ".." ||
      path.posix.isAbsolute(relativeInstallPath)
    ) {
      continue;
    }
    if (relativeInstallPath.length === 0 || relativeInstallPath.includes("/")) {
      return { ok: false, error: `fresh OpenClaw plugin install path is invalid for ${id}` };
    }

    const extensionDir = relativeInstallPath;
    if (!isSafeOpenClawExtensionDirName(extensionDir)) {
      return { ok: false, error: `fresh OpenClaw extension directory is invalid for ${id}` };
    }
    extensionDirs.add(extensionDir);
  }
  return { ok: true, extensionDirs: [...extensionDirs].sort() };
}
