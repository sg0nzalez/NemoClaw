// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxControl } from "../adapters/openshell/sandbox-control.js";
import { shellQuote } from "../runner.js";
import {
  mergeOpenClawRestoredConfig,
  type OpenClawConfigMergeOptions,
} from "./openclaw-config-merge.js";
import {
  hasCompleteOpenClawImagePluginProvenance,
  type OpenClawImagePluginInstall,
} from "./openclaw-plugin-restore.js";

export type OpenClawConfigRestoreInputResult =
  | { ok: true; input: Buffer }
  | { ok: false; error: string };

export interface OpenClawConfigRestoreFromSandboxOptions {
  backupContents: Buffer;
  dir: string;
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  log?: (message: string) => void;
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  sandboxControl: OpenShellSandboxControl;
  sandboxName: string;
  specPath: string;
}

function openClawConfigRemotePath(dir: string, specPath: string): string {
  return `${dir.replace(/\/+$/, "")}/${specPath}`;
}

export function buildOpenClawConfigReadCommand(dir: string, specPath: string): string {
  const remotePath = openClawConfigRemotePath(dir, specPath);
  const quotedRemotePath = shellQuote(remotePath);
  return [
    `src=${quotedRemotePath}`,
    '[ ! -e "$src" ] && exit 2',
    '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe state file: $src" >&2; exit 10; }',
    'cat -- "$src"',
  ].join("; ");
}

async function readCurrentOpenClawConfig(
  sandboxControl: OpenShellSandboxControl,
  sandboxName: string,
  dir: string,
  specPath: string,
  log: (message: string) => void,
): Promise<Buffer | null> {
  const command = buildOpenClawConfigReadCommand(dir, specPath);
  const result = await sandboxControl.exec({
    sandboxName,
    command: ["sh", "-c", command],
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024 * 1024,
    stdoutEncoding: "buffer",
  });
  if (result.status === 0 && !result.error && !result.signal && result.stdoutBytes) {
    return result.stdoutBytes;
  }
  if (result.status !== 2) {
    const detail =
      result.stderr.trim() ||
      result.error?.message ||
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    log(`WARNING: state file current read ${specPath} failed: ${detail.substring(0, 200)}`);
  }
  return null;
}

export function buildOpenClawConfigRestoreInput(
  backupContents: Buffer,
  currentContents: Buffer | null,
  options: OpenClawConfigMergeOptions = {},
): OpenClawConfigRestoreInputResult {
  if (!currentContents) {
    return { ok: false, error: "openclaw.json selective merge requires current rebuilt config" };
  }

  try {
    const backedUpConfig = JSON.parse(backupContents.toString("utf-8")) as unknown;
    const currentConfig = JSON.parse(currentContents.toString("utf-8")) as unknown;
    const merged = mergeOpenClawRestoredConfig(backedUpConfig, currentConfig, options);
    return { ok: true, input: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `openclaw.json selective merge failed; refusing unsafe wholesale backup restore: ${detail}`,
    };
  }
}

export async function buildOpenClawConfigRestoreInputFromSandbox({
  backupContents,
  dir,
  freshImagePluginInstalls,
  log = () => {},
  previousImagePluginInstalls,
  sandboxControl,
  sandboxName,
  specPath,
}: OpenClawConfigRestoreFromSandboxOptions): Promise<OpenClawConfigRestoreInputResult> {
  if ((previousImagePluginInstalls === undefined) !== (freshImagePluginInstalls === undefined)) {
    return {
      ok: false,
      error: "Complete previous and fresh OpenClaw image plugin provenance is required",
    };
  }
  if (
    freshImagePluginInstalls !== undefined &&
    !hasCompleteOpenClawImagePluginProvenance(freshImagePluginInstalls, dir)
  ) {
    return { ok: false, error: "Fresh OpenClaw image plugin provenance is incomplete" };
  }
  if (
    previousImagePluginInstalls !== undefined &&
    !hasCompleteOpenClawImagePluginProvenance(previousImagePluginInstalls, dir)
  ) {
    return { ok: false, error: "Previous OpenClaw image plugin provenance is incomplete" };
  }
  return buildOpenClawConfigRestoreInput(
    backupContents,
    await readCurrentOpenClawConfig(sandboxControl, sandboxName, dir, specPath, log),
    { freshImagePluginInstalls, previousImagePluginInstalls },
  );
}
