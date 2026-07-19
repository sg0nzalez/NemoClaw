// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import YAML from "yaml";

import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const execFileAsync = promisify(execFile);
const CLOUDLFARED_STEP_NAME = "Install and verify cloudflared prerequisite";

interface CloudflaredPin {
  version: string;
  debSha256: string;
}

function executableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return undefined;
}

function requirePin(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`inference-routing ${label} is missing or invalid`);
  }
  return value;
}

export function readInferenceRoutingCloudflaredPin(
  workflowPath = path.join(REPO_ROOT, ".github", "workflows", "e2e.yaml"),
): CloudflaredPin {
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; env?: Record<string, unknown> }> }>;
  };
  const step = workflow.jobs?.["inference-routing"]?.steps?.find(
    (candidate) => candidate.name === CLOUDLFARED_STEP_NAME,
  );
  return {
    version: requirePin(
      step?.env?.CLOUDFLARED_VERSION,
      "cloudflared version pin",
      /^\d+\.\d+\.\d+$/,
    ),
    debSha256: requirePin(
      step?.env?.CLOUDFLARED_DEB_SHA256,
      "cloudflared SHA256 pin",
      /^[0-9a-f]{64}$/,
    ),
  };
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  return result.stdout;
}

export async function resolveVerifiedCloudflaredBinary(
  cleanup: Pick<CleanupRegistry, "add">,
): Promise<string> {
  const existing = executableOnPath("cloudflared");
  if (existing) return existing;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("cloudflared is required for the DNS-backed HTTPS routing proof");
  }

  const pin = readInferenceRoutingCloudflaredPin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-"));
  cleanup.add(`remove verified cloudflared prerequisite ${root}`, () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deb = path.join(root, `cloudflared-${pin.version}-linux-amd64.deb`);
  const url =
    `https://github.com/cloudflare/cloudflared/releases/download/${pin.version}/` +
    "cloudflared-linux-amd64.deb";
  await commandOutput("curl", [
    "--fail",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    url,
    "--output",
    deb,
  ]);

  const actualSha256 = createHash("sha256").update(fs.readFileSync(deb)).digest("hex");
  if (actualSha256 !== pin.debSha256) {
    throw new Error(`cloudflared package SHA256 mismatch: expected ${pin.debSha256}`);
  }
  const packageName = (await commandOutput("dpkg-deb", ["-f", deb, "Package"])).trim();
  const version = (await commandOutput("dpkg-deb", ["-f", deb, "Version"])).trim();
  const architecture = (await commandOutput("dpkg-deb", ["-f", deb, "Architecture"])).trim();
  if (packageName !== "cloudflared" || version !== pin.version || architecture !== "amd64") {
    throw new Error(
      `unexpected cloudflared package metadata: package=${packageName} version=${version} architecture=${architecture}`,
    );
  }

  const extracted = path.join(root, "extracted");
  await commandOutput("dpkg-deb", ["-x", deb, extracted]);
  const binary = path.join(extracted, "usr", "bin", "cloudflared");
  fs.accessSync(binary, fs.constants.X_OK);
  const reportedVersion = await commandOutput(binary, ["--version"]);
  if (!reportedVersion.includes(`cloudflared version ${pin.version}`)) {
    throw new Error(`unexpected cloudflared version output: ${reportedVersion.trim()}`);
  }
  return binary;
}
