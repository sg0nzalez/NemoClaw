// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

type ReusableCallerJob = {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
};

type Workflow = {
  on?: {
    workflow_call?: {
      inputs?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
  jobs?: Record<string, ReusableCallerJob>;
};

describe("Brev nightly workflow contract", () => {
  const nightly = readYaml<Workflow>(".github/workflows/brev-nightly-e2e.yaml");
  const branchValidation = readYaml<Workflow>(".github/workflows/e2e-branch-validation.yaml");

  it("passes only declared inputs and secrets to branch validation", () => {
    const declaredInputs = new Set(Object.keys(branchValidation.on?.workflow_call?.inputs ?? {}));
    const declaredSecrets = new Set(Object.keys(branchValidation.on?.workflow_call?.secrets ?? {}));
    const callerJobs = Object.entries(nightly.jobs ?? {}).filter(
      ([, job]) => job.uses === "./.github/workflows/e2e-branch-validation.yaml",
    );

    expect(callerJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of callerJobs) {
      const unknownInputs = Object.keys(job.with ?? {}).filter((name) => !declaredInputs.has(name));
      const unknownSecrets = Object.keys(job.secrets ?? {}).filter((name) => !declaredSecrets.has(name));

      expect(unknownInputs, `${jobName} passes unsupported reusable workflow inputs`).toEqual([]);
      expect(unknownSecrets, `${jobName} passes unsupported reusable workflow secrets`).toEqual([]);
    }
  });

  it("does not expose stale published-launchable controls", () => {
    const dispatchInputs = Object.keys(nightly.on?.workflow_dispatch?.inputs ?? {});
    const callerInputs = Object.values(nightly.jobs ?? {}).flatMap((job) => Object.keys(job.with ?? {}));

    expect(dispatchInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("use_published_launchable");
  });

  it("configures Docker bridge firewall rules in the CI launchable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nemoclaw-brev-firewall-"));

    try {
      const sudoLog = join(tmp, "sudo.log");
      const ufwLog = join(tmp, "ufw.log");
      const launchLog = join(tmp, "launch.log");

      writeExecutable(
        join(tmp, "sudo"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NEMOCLAW_FAKE_SUDO_LOG"
if [ "\${1:-}" = "-n" ]; then
  shift
fi
exec "$@"
`,
      );
      writeExecutable(
        join(tmp, "ufw"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NEMOCLAW_FAKE_UFW_LOG"
`,
      );
      writeExecutable(
        join(tmp, "getent"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "passwd" ]; then
  printf '%s:x:1000:1000::%s:/bin/bash\\n' "\${2:-ci}" "$HOME"
fi
`,
      );

      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `
set -euo pipefail
source <(awk '/Wait for apt locks/{exit} {print}' scripts/brev-launchable-ci-cpu.sh)
configure_openshell_bridge_firewall
`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf-8",
          env: {
            ...process.env,
            LAUNCH_LOG: launchLog,
            NEMOCLAW_FAKE_SUDO_LOG: sudoLog,
            NEMOCLAW_FAKE_UFW_LOG: ufwLog,
            PATH: `${tmp}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(sudoLog, "utf-8").trim().split("\n")).toEqual([
        "-n ufw allow from 172.16.0.0/12 to any port 8080 proto tcp",
        "-n ufw allow from 172.16.0.0/12 to any port 11435 proto tcp",
      ]);
      expect(readFileSync(ufwLog, "utf-8").trim().split("\n")).toEqual([
        "allow from 172.16.0.0/12 to any port 8080 proto tcp",
        "allow from 172.16.0.0/12 to any port 11435 proto tcp",
      ]);
      expect(readFileSync(launchLog, "utf-8")).toMatch(/Allowed Docker bridge to gateway:8080/);
      expect(readFileSync(launchLog, "utf-8")).toMatch(
        /Allowed Docker bridge to auth-proxy:11435/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
