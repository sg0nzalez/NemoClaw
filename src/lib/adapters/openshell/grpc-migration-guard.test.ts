// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");

const PRODUCTION_TARGETS = [
  "src/lib/actions/sandbox",
  "src/lib/state/sandbox.ts",
  "src/lib/skill-install.ts",
  "src/lib/skill-remote.ts",
  "src/lib/onboard/agent-fixed-forward.ts",
  "src/lib/onboard/dashboard.ts",
  "src/lib/onboard/dashboard-access.ts",
  "src/lib/onboard/sandbox-verification-exec.ts",
  "src/lib/sandbox/version.ts",
  "src/lib/share-command.ts",
  "src/lib/share-command-deps.ts",
  "src/lib/status-command-deps.ts",
  "src/lib/tunnel/services.ts",
  "src/lib/verify-deployment.ts",
  "src/lib/adapters/openshell/direct-grpc.ts",
  "src/lib/adapters/openshell/forward-bridge-runner.ts",
  "src/lib/adapters/openshell/grpc.ts",
  "src/lib/adapters/openshell/sync-runner.ts",
  "package.json",
  "scripts/install.sh",
];

const BANNED = [
  /captureSandboxSshConfig/,
  /sandbox ssh-config/,
  /spawnSync\(\s*["']ssh["']/,
  /\bsshfs\b/,
  /sandbox upload/,
  /sandbox download/,
  /forward start --background/,
  /openshell forward start/,
];

function filesUnder(target: string): string[] {
  const absolute = path.join(ROOT, target);
  if (fs.statSync(absolute).isFile()) return [absolute];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(absolute);
  return out;
}

describe("OpenShell SDK migration guard", () => {
  it("keeps sandbox lifecycle production code off SSH shelling and legacy OpenShell CLI forwards", () => {
    const violations: string[] = [];
    for (const target of PRODUCTION_TARGETS) {
      for (const file of filesUnder(target)) {
        const rel = path.relative(ROOT, file);
        const text = fs.readFileSync(file, "utf-8");
        for (const pattern of BANNED) {
          if (pattern.test(text)) violations.push(`${rel}: ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
