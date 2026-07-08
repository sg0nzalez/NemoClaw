// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const checkPath = path.join(repoRoot, "scripts", "check-dcode-profile-import-gate.sh");

type GateResult = {
  calls: string;
  status: number | null;
  stderr: string;
  stdout: string;
};

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

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
  it("hashes both first-party plugin build inputs before local installation", () => {
    const dockerfile = fs.readFileSync(path.join(agentDir, "Dockerfile"), "utf8");
    const hashGate = "sha256sum -c -";
    const install = "/opt/venv/bin/pip3 install";

    expect(dockerfile).toContain(
      "d5e2e8214e46fd61265d2377a3f9a30d827f19f08fc50272980b69fda3669fc1' '/opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/__init__.py'",
    );
    expect(dockerfile).toContain(
      "7ba7b77bd6f889cc861eddbe3e38fc1f4433a85b7bc2a9b516e19a19a37a7686' '/opt/nemoclaw-deepagents-profile-plugin/pyproject.toml'",
    );
    expect(dockerfile.indexOf(hashGate)).toBeLessThan(dockerfile.indexOf(install));
  });

  it("checks isolated imports before dependency consistency", () => {
    const dockerfile = fs.readFileSync(path.join(agentDir, "Dockerfile"), "utf8");

    expect(dockerfile).toContain(
      '/opt/venv/bin/python3 -I -c \'import nemoclaw_deepagents_profile; print("NEMOCLAW_DCODE_PROFILE_" + "IMPORT_GATE", flush=True); import deepagents; import deepagents_code\'',
    );
    expect(dockerfile.indexOf('print("NEMOCLAW_DCODE_PROFILE_"')).toBeLessThan(
      dockerfile.indexOf("/opt/venv/bin/pip3 check"),
    );
  });

  it("strips and verifies both reviewed upstream distributions", () => {
    const fixture = readRepoFile("test", "Dockerfile.dcode-profile-missing-dependencies");

    expect(fixture).toContain("pip3 uninstall --yes deepagents-code deepagents");
    expect(fixture).toContain('find_spec("deepagents") is None');
    expect(fixture).toContain('find_spec("deepagents_code") is None');
  });

  it("accepts only the expected production-build failure at the runtime marker", () => {
    const result = runGateWithFakeDocker("expected-failure");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "DCode profile import gate rejected a base missing deepagents and deepagents-code",
    );
    expect(result.calls).toContain("--file test/Dockerfile.dcode-profile-missing-dependencies");
    expect(result.calls).toContain("--file agents/langchain-deepagents-code/Dockerfile");
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
