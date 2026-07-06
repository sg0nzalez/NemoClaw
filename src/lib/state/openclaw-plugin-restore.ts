// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { isRecord } from "../core/json-types.js";
import { shellQuote } from "../core/shell-quote.js";

const MAX_OPENCLAW_IMAGE_MANAGED_PLUGIN_INSTALLS = 128;
// Bound sandbox-controlled registry strings before path normalization.
const MAX_OPENCLAW_PLUGIN_INSTALL_PATH_LENGTH = 4096;
const MAX_OPENCLAW_PLUGIN_INSTALL_PATH_SEGMENTS = 64;
const OPENCLAW_EXTENSION_GLOB_CHARS = ["/", "\\", "*", "?", "[", "]"] as const;

export type OpenClawManagedExtensionDiscoveryResult =
  | { ok: true; extensionDirs: string[]; pluginInstalls: OpenClawImagePluginInstall[] }
  | { ok: false; error: string };

export interface OpenClawImagePluginInstall {
  readonly id: string;
  readonly installPath: string;
}

const OPENCLAW_PLUGIN_INDEX_SQLITE_PY = [
  "import json, sqlite3, sys, urllib.parse",
  'uri = "file:" + urllib.parse.quote(sys.argv[1], safe="/") + "?mode=ro"',
  "conn = sqlite3.connect(uri, uri=True, timeout=30)",
  "try:",
  '    conn.execute("PRAGMA query_only=ON")',
  '    conn.execute("PRAGMA busy_timeout=30000")',
  "    row = conn.execute(\"SELECT install_records_json FROM installed_plugin_index WHERE index_key = 'installed-plugin-index'\").fetchone()",
  "    if not row or not row[0]: raise SystemExit(12)",
  "    records = json.loads(row[0])",
  "    print(json.dumps({'version': 1, 'installRecords': records}, separators=(',', ':')))",
  "finally:",
  "    conn.close()",
].join("\n");

export function buildFreshOpenClawPluginIndexSqliteReadCommand(dir: string): string {
  const sqlitePath = `${dir.replace(/\/+$/, "")}/state/openclaw.sqlite`;
  const quotedSqlitePath = shellQuote(sqlitePath);
  return [
    `db=${quotedSqlitePath}`,
    '[ -e "$db" ] || [ -L "$db" ] || exit 2',
    '[ -f "$db" ] && [ ! -L "$db" ] || { echo "unsafe OpenClaw state database: $db" >&2; exit 10; }',
    'hardlink_count="$(find "$db" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
    '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked OpenClaw state database rejected: $db" >&2; exit 11; }',
    `python3 -c ${shellQuote(OPENCLAW_PLUGIN_INDEX_SQLITE_PY)} "$db"`,
  ].join("; ");
}

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

function validateOpenClawImagePluginInstall(
  id: unknown,
  installPath: unknown,
): OpenClawImagePluginInstall | null {
  if (typeof id !== "string" || !isSafeOpenClawPluginInstallId(id)) return null;
  if (
    typeof installPath !== "string" ||
    installPath.length > MAX_OPENCLAW_PLUGIN_INSTALL_PATH_LENGTH ||
    installPath.split("/").filter(Boolean).length > MAX_OPENCLAW_PLUGIN_INSTALL_PATH_SEGMENTS ||
    !path.posix.isAbsolute(installPath) ||
    path.posix.normalize(installPath) !== installPath
  ) {
    return null;
  }
  return { id, installPath };
}

function extensionDirForInstall(
  install: OpenClawImagePluginInstall,
  dir: string,
): { ok: true; extensionDir: string | null } | { ok: false; error: string } {
  const extensionsDir = `${dir.replace(/\/+$/, "")}/extensions`;
  const relativeInstallPath = path.posix.relative(extensionsDir, install.installPath);
  if (
    relativeInstallPath.startsWith("../") ||
    relativeInstallPath === ".." ||
    path.posix.isAbsolute(relativeInstallPath)
  ) {
    return { ok: true, extensionDir: null };
  }
  if (
    relativeInstallPath.length === 0 ||
    relativeInstallPath.includes("/") ||
    !isSafeOpenClawExtensionDirName(relativeInstallPath)
  ) {
    return {
      ok: false,
      error: `fresh OpenClaw plugin install path is invalid for ${install.id}`,
    };
  }
  return { ok: true, extensionDir: relativeInstallPath };
}

function validateOpenClawImagePluginInstalls(
  entries: readonly (readonly [string, unknown])[],
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  if (entries.length > MAX_OPENCLAW_IMAGE_MANAGED_PLUGIN_INSTALLS) {
    return {
      ok: false,
      error: `fresh OpenClaw registry has too many plugin installs (${entries.length})`,
    };
  }

  const ids = new Set<string>();
  const installPaths = new Set<string>();
  const extensionDirs = new Set<string>();
  const pluginInstalls: OpenClawImagePluginInstall[] = [];
  for (const [id, metadata] of entries) {
    const installPath = isRecord(metadata) ? metadata.installPath : undefined;
    const install = validateOpenClawImagePluginInstall(id, installPath);
    if (!install) {
      return { ok: false, error: `fresh OpenClaw plugin install metadata is invalid: ${id}` };
    }
    if (ids.has(install.id) || installPaths.has(install.installPath)) {
      return { ok: false, error: `fresh OpenClaw plugin install provenance is duplicated: ${id}` };
    }
    const projected = extensionDirForInstall(install, dir);
    if (!projected.ok) return projected;
    if (projected.extensionDir && extensionDirs.has(projected.extensionDir)) {
      return { ok: false, error: `fresh OpenClaw extension directory is duplicated: ${id}` };
    }
    ids.add(install.id);
    installPaths.add(install.installPath);
    pluginInstalls.push(install);
    if (projected.extensionDir) extensionDirs.add(projected.extensionDir);
  }
  return {
    ok: true,
    extensionDirs: [...extensionDirs].sort(),
    pluginInstalls: pluginInstalls.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function parseOpenClawImagePluginInstalls(
  value: unknown,
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: "OpenClaw image plugin provenance is invalid" };
  }
  return validateOpenClawImagePluginInstalls(
    value.map((entry) => [isRecord(entry) && typeof entry.id === "string" ? entry.id : "", entry]),
    dir,
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

  const entries = Object.keys(installs)
    .sort()
    .map((id) => [id, installs[id]] as const);
  return validateOpenClawImagePluginInstalls(entries, dir);
}
