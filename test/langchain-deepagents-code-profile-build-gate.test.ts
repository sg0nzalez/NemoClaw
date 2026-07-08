// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const checkPath = path.join(repoRoot, "scripts", "check-dcode-profile-import-gate.sh");

type GateResult = {
  calls: string;
  status: number | null;
  stderr: string;
  stdout: string;
};

function runGateWithFakeDocker(mode: "expected-failure" | "early-failure" | "success"): GateResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-profile-import-gate-"));
  const dockerPath = path.join(tmp, "docker");
  const callLog = path.join(tmp, "docker.log");
  fs.writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
case " $* " in
  *" --file agents/langchain-deepagents-code/Dockerfile "*)
    case "\${FAKE_DOCKER_MODE:?}" in
      expected-failure)
        printf '%s\\n' NEMOCLAW_DCODE_PROFILE_IMPORT_GATE "ModuleNotFoundError: No module named 'deepagents'"
        exit 1
        ;;
      early-failure)
        printf '%s\\n' "production build failed before import gate"
        exit 1
        ;;
      success) exit 0 ;;
    esac
    ;;
esac
exit 0
`,
    "utf8",
  );
  fs.chmodSync(dockerPath, 0o755);
  try {
    const result = spawnSync("bash", [checkPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: callLog,
        FAKE_DOCKER_MODE: mode,
        PATH: `${tmp}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
    });
    return {
      calls: fs.readFileSync(callLog, "utf8"),
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("LangChain Deep Agents Code profile build gate", () => {
  it("accepts only the expected production-build failure at the runtime marker", () => {
    const result = runGateWithFakeDocker("expected-failure");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "DCode profile import gate rejected a base missing deepagents and deepagents-code",
    );
    expect(result.calls).toContain("--file agents/langchain-deepagents-code/Dockerfile.base");
    expect(result.calls).toContain("--file test/Dockerfile.dcode-profile-missing-dependencies");
    expect(result.calls).toContain("--file agents/langchain-deepagents-code/Dockerfile");
    expect(result.calls).not.toContain(":latest");
  });

  it("rejects a production build that unexpectedly succeeds", () => {
    const result = runGateWithFakeDocker("success");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DCode production image unexpectedly built without deepagents dependencies",
    );
  });

  it("rejects a failure before the runtime import marker", () => {
    const result = runGateWithFakeDocker("early-failure");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DCode build failed before reaching the profile import gate");
  });
});
