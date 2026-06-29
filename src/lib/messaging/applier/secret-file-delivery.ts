// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChannelManifest, MessagingAgentId, MessagingChannelId } from "../manifest";

// Some channel secrets must be consumed by the agent IN-process (e.g. a Google
// service-account JSON the channel signs JWTs with). NemoClaw's normal secret
// path — an OpenShell provider + `openshell:resolve:env:` placeholder — only
// materializes the real value in OUTBOUND HTTP, never in-process, so it cannot
// satisfy local signing. `secretFiles` instead uploads the raw secret to a file
// inside the sandbox after create/rebuild. The value never touches the agent
// config or the image; the file lives in the sandbox volume.

const DEFAULT_MODE = "600";

/** One resolved secret-file delivery for an active channel. */
export interface MessagingSecretFileTarget {
  readonly channelId: MessagingChannelId;
  readonly secretFileId: string;
  /** Env key of the captured secret value to deliver. */
  readonly envKey: string;
  /** Absolute destination path inside the sandbox. */
  readonly target: string;
  /** Octal mode applied to the delivered file. */
  readonly mode: string;
}

/** Resolve the in-sandbox secret-file deliveries for the active channels + agent. */
export function collectMessagingSecretFiles(
  manifests: readonly ChannelManifest[],
  activeChannelIds: readonly MessagingChannelId[],
  agent: MessagingAgentId,
): MessagingSecretFileTarget[] {
  const active = new Set(activeChannelIds);
  const targets: MessagingSecretFileTarget[] = [];
  for (const manifest of manifests) {
    if (!active.has(manifest.id)) continue;
    for (const file of manifest.secretFiles ?? []) {
      if (file.agent !== agent) continue;
      const input = manifest.inputs.find(
        (entry) => entry.id === file.sourceInput && entry.kind === "secret",
      );
      if (!input?.envKey) continue;
      targets.push({
        channelId: manifest.id,
        secretFileId: file.id,
        envKey: input.envKey,
        target: file.target,
        mode: file.mode ?? DEFAULT_MODE,
      });
    }
  }
  return targets;
}

export interface SecretFileDeliveryDeps {
  /** Read the captured secret value (process env / credential store). */
  readonly readSecret: (envKey: string) => string | null | undefined;
  /** Upload a host file to the sandbox path. Return false on failure. */
  readonly uploadToSandbox: (sandboxName: string, localPath: string, target: string) => boolean;
  /** Run a command inside the sandbox (mkdir/chmod). Return false on failure. */
  readonly execInSandbox: (sandboxName: string, argv: readonly string[]) => boolean;
  /** Restart the in-sandbox gateway so it re-reads config + the new files. */
  readonly restartGateway: (sandboxName: string) => void;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  /** Test seam: write the secret to a host temp file, returning its path. */
  readonly writeTempFile?: (contents: string) => string;
  readonly removeTempFile?: (path: string) => void;
}

export interface SecretFileDeliveryResult {
  readonly delivered: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Deliver each secret file to the sandbox, then restart the gateway once if any
 * file was written (so the channel can read it on the next boot). Missing
 * secrets are skipped with a warning rather than aborting the run.
 */
export function deliverMessagingSecretFiles(
  sandboxName: string,
  targets: readonly MessagingSecretFileTarget[],
  deps: SecretFileDeliveryDeps,
): SecretFileDeliveryResult {
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? log;
  const writeTempFile = deps.writeTempFile ?? defaultWriteTempFile;
  const removeTempFile = deps.removeTempFile ?? defaultRemoveTempFile;

  const delivered: string[] = [];
  const skipped: string[] = [];
  let changed = false;

  for (const target of targets) {
    const value = normalizeSecret(deps.readSecret(target.envKey));
    if (!value) {
      warn(
        `  ⚠ ${target.channelId}: secret ${target.envKey} is unavailable — skipped ${target.target}`,
      );
      skipped.push(target.secretFileId);
      continue;
    }
    const tempPath = writeTempFile(value);
    try {
      const dir = dirname(target.target);
      deps.execInSandbox(sandboxName, [
        "sh",
        "-c",
        `mkdir -p ${shellQuote(dir)} && chmod 750 ${shellQuote(dir)}`,
      ]);
      if (!deps.uploadToSandbox(sandboxName, tempPath, target.target)) {
        warn(`  ⚠ ${target.channelId}: failed to upload secret file to ${target.target}`);
        skipped.push(target.secretFileId);
        continue;
      }
      deps.execInSandbox(sandboxName, ["chmod", target.mode, target.target]);
      delivered.push(target.secretFileId);
      changed = true;
      log(`  ✓ ${target.channelId}: delivered service account file to the sandbox`);
    } finally {
      removeTempFile(tempPath);
    }
  }

  if (changed) {
    log("  Restarting in-sandbox gateway to load the delivered secret file(s)…");
    deps.restartGateway(sandboxName);
  }
  return { delivered, skipped };
}

function normalizeSecret(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

// Single-quote for `sh -c`; embedded single quotes are closed/escaped/reopened.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultWriteTempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-secret-"));
  const file = join(dir, "secret");
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function defaultRemoveTempFile(path: string): void {
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
