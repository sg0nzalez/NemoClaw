// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";
import path from "node:path";

import { loadAgent } from "../agent/defs.js";
import { shellQuote } from "../runner.js";
import { createTempSshConfig } from "../sandbox/temp-ssh-config.js";

import * as registry from "./registry.js";
import { getSshConfig, sshArgs } from "./sandbox.js";

export const USER_MANAGED_FILES_BASE = "/sandbox";

export interface UserManagedFilesProbe {
  declared: string[];
  existing: string[];
}

export interface UnpreservedSandboxRootProbe {
  existing: string[];
}

const IMAGE_MANAGED_SANDBOX_ROOT_ENTRIES = new Set([".bashrc", ".nemoclaw", ".profile"]);

const _verbose = (): boolean => process.env.NEMOCLAW_REBUILD_VERBOSE === "1";

function _log(msg: string): void {
  if (_verbose()) console.error(`  [user-managed-files-probe ${new Date().toISOString()}] ${msg}`);
}

export function probeUserManagedFiles(sandboxName: string): UserManagedFilesProbe {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  const agent = loadAgent(agentName);
  const declared = Array.isArray(agent.userManagedFiles) ? [...agent.userManagedFiles] : [];
  if (declared.length === 0) return { declared, existing: [] };

  _log(
    `sandbox=${sandboxName}, agent=${agentName}, declared=[${declared.join(",")}], base=${USER_MANAGED_FILES_BASE}`,
  );

  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("no SSH config — cannot probe declared user-managed files");
    throw new Error(
      "user-managed file probe failed: no SSH config available for sandbox " + sandboxName,
    );
  }

  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-umf-");
  const configFile = tempSshConfig.file;
  try {
    const probeCmd =
      declared
        .map(
          (relPath) =>
            `if [ -f ${shellQuote(`${USER_MANAGED_FILES_BASE}/${relPath}`)} ]; then printf '%s\\n' ${shellQuote(relPath)}; fi`,
        )
        .join("; ") + " 2>/dev/null";
    const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), probeCmd], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    const stdout = (result.stdout || "").trim();
    if (result.status !== 0 && stdout.length === 0) {
      _log(
        `SSH probe failed: exit=${result.status}, stderr=${(result.stderr || "").trim().substring(0, 200)}`,
      );
      throw new Error(
        `user-managed file probe failed: ssh exit=${result.status}, stderr=${(result.stderr || "").trim().substring(0, 200)}`,
      );
    }
    const existing = stdout.split("\n").filter((line) => line.length > 0);
    _log(`${existing.length}/${declared.length} present in sandbox`);
    return { declared, existing };
  } finally {
    tempSshConfig.cleanup();
  }
}

/**
 * Find top-level /sandbox entries outside image-owned roots and the agent's
 * config root.
 *
 * Strict upgrade backup cannot safely archive arbitrary paths: they can hold
 * raw credentials and can collide with files owned by the replacement image.
 * Callers use this probe to stop before destructive legacy recreation unless
 * the user explicitly accepts that those paths are outside the snapshot.
 */
export function probeUnpreservedSandboxRootEntries(
  sandboxName: string,
): UnpreservedSandboxRootProbe {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  const agent = loadAgent(agentName);
  const managedEntries = new Set(IMAGE_MANAGED_SANDBOX_ROOT_ENTRIES);
  const configDir = path.posix.normalize(agent.configPaths.dir.replace(/\\/g, "/"));
  if (path.posix.dirname(configDir) === USER_MANAGED_FILES_BASE) {
    const configEntry = path.posix.basename(configDir);
    managedEntries.add(configEntry);
    // Older OpenClaw and Hermes images used a sibling durable data directory
    // behind the canonical config path. It belongs to the same manifest-backed
    // state and must not be reported as arbitrary root data.
    managedEntries.add(`${configEntry}-data`);
  }

  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    throw new Error(
      "unpreserved sandbox-root probe failed: no SSH config available for sandbox " + sandboxName,
    );
  }

  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-root-probe-");
  const configFile = tempSshConfig.file;
  try {
    const probeCmd =
      `find -P ${shellQuote(USER_MANAGED_FILES_BASE)} -mindepth 1 -maxdepth 1 ` +
      `-printf '%f\\0' 2>/dev/null`;
    const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), probeCmd], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (result.status !== 0 || result.error || result.signal) {
      const detail =
        result.stderr?.toString().trim() ||
        result.error?.message ||
        (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
      throw new Error(`unpreserved sandbox-root probe failed: ${detail.substring(0, 200)}`);
    }

    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : String(result.stdout || "");
    const existing = stdout
      .split("\0")
      .filter((entry) => entry.length > 0 && !managedEntries.has(entry))
      .map((entry) => `${USER_MANAGED_FILES_BASE}/${entry}`)
      .sort();
    return { existing };
  } finally {
    tempSshConfig.cleanup();
  }
}
