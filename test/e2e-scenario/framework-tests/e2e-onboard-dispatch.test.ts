// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ONBOARD_DIR = path.join(REPO_ROOT, "test/e2e-scenario/nemoclaw_scenarios/onboard");

function runBash(
  script: string,
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }
  return spawnSync("bash", ["--noprofile", "--norc"], {
    env: childEnv,
    encoding: "utf8",
    input: script,
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("server did not bind to a TCP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

describe("E2E onboarding shell dispatcher", () => {
  it("injects the fixture NVIDIA key for invalid-key negative onboarding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-invalid-nvidia-key-"));
    const fakeBin = path.join(tmp, "bin");
    const capturedEnv = path.join(tmp, "captured-env");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" = "onboard" ]]; then
  expected='onboard --non-interactive --yes'
  if [[ "$*" != "\${expected}" ]]; then
    echo "unexpected nemoclaw args: $*" >&2
    exit 2
  fi
  {
    printf 'NVIDIA_API_KEY=%s\\n' "\${NVIDIA_API_KEY:-unset}"
    printf 'NEMOCLAW_POLICY_MODE=%s\\n' "\${NEMOCLAW_POLICY_MODE:-unset}"
  } >"${capturedEnv}"
  if [[ "\${NVIDIA_API_KEY:-}" != "not-a-nvidia-key" ]]; then
    echo "unexpected NVIDIA_API_KEY: \${NVIDIA_API_KEY:-unset}" >&2
    exit 2
  fi
  if [[ "\${NEMOCLAW_POLICY_MODE:-}" != "skip" ]]; then
    echo "unexpected NEMOCLAW_POLICY_MODE: \${NEMOCLAW_POLICY_MODE:-unset}" >&2
    exit 2
  fi
  echo "Invalid NVIDIA API key. Must start with nvapi-" >&2
  exit 1
fi
echo "unexpected nemoclaw invocation: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=ubuntu-invalid-nvidia-key-negative\nE2E_SANDBOX_NAME=e2e-invalid-key\n",
      );
      const result = runBash(
        `
        set -euo pipefail
        test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh e2e_onboard cloud-openclaw-invalid-nvidia-key "${ONBOARD_DIR}/dispatch.sh"
      `,
        {
          E2E_ACTION_ID: "onboarding.profile.cloud-openclaw-invalid-nvidia-key",
          E2E_CONTEXT_DIR: tmp,
          E2E_PHASE: "onboarding",
          NVIDIA_API_KEY: undefined,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: tmp,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Invalid NVIDIA API key");
      expect(fs.readFileSync(capturedEnv, "utf8")).toBe(
        "NVIDIA_API_KEY=not-a-nvidia-key\nNEMOCLAW_POLICY_MODE=skip\n",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed gateway conflict ports before invoking onboarding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gateway-conflict-bad-port-"));
    const fakeBin = path.join(tmp, "bin");
    const invoked = path.join(tmp, "nemoclaw-invoked");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
touch "${invoked}"
echo "nemoclaw should not have been invoked" >&2
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=ubuntu-gateway-port-conflict-negative\nE2E_SANDBOX_NAME=e2e-port-conflict\n",
      );
      const result = runBash(
        `
        set -euo pipefail
        test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh e2e_onboard cloud-openclaw-gateway-port-conflict "${ONBOARD_DIR}/dispatch.sh"
      `,
        {
          E2E_ACTION_ID: "onboarding.profile.cloud-openclaw-gateway-port-conflict",
          E2E_CONTEXT_DIR: tmp,
          E2E_PHASE: "onboarding",
          NEMOCLAW_ONBOARD_NEGATIVE_CONFLICT_PORT: "../18080",
          NVIDIA_API_KEY: "secret-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: tmp,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(`${result.stdout}\n${result.stderr}`).toContain("invalid gateway conflict port");
      expect(fs.existsSync(invoked)).toBe(false);
      expect(fs.readdirSync(tmp).some((entry) => entry.startsWith("gateway-port-holder-"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("holds the requested gateway port during conflict-negative onboarding", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gateway-conflict-"));
    const fakeBin = path.join(tmp, "bin");
    const port = await getAvailablePort();
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" = "onboard" ]]; then
  expected='onboard --non-interactive --yes'
  if [[ "$*" != "\${expected}" ]]; then
    echo "unexpected nemoclaw args: $*" >&2
    exit 2
  fi
  if [[ "\${NEMOCLAW_GATEWAY_PORT:-}" != "\${EXPECTED_PORT}" ]]; then
    echo "unexpected gateway port: \${NEMOCLAW_GATEWAY_PORT:-unset}" >&2
    exit 2
  fi
  node -e 'const net=require("node:net"); const port=Number(process.argv[1]); const s=net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); process.exit(0); }); s.once("error", () => process.exit(1)); setTimeout(() => process.exit(1), 250);' "\${EXPECTED_PORT}" || {
    echo "gateway conflict port was not held" >&2
    exit 2
  }
  echo "Port \${NEMOCLAW_GATEWAY_PORT} is not available." >&2
  exit 1
fi
echo "unexpected nemoclaw invocation: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=ubuntu-gateway-port-conflict-negative\nE2E_SANDBOX_NAME=e2e-port-conflict\n",
      );
      const result = runBash(
        `
        set -euo pipefail
        test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh e2e_onboard cloud-openclaw-gateway-port-conflict "${ONBOARD_DIR}/dispatch.sh"
      `,
        {
          E2E_ACTION_ID: "onboarding.profile.cloud-openclaw-gateway-port-conflict",
          E2E_CONTEXT_DIR: tmp,
          E2E_PHASE: "onboarding",
          EXPECTED_PORT: String(port),
          NEMOCLAW_ONBOARD_NEGATIVE_CONFLICT_PORT: String(port),
          NVIDIA_API_KEY: "secret-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: tmp,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(`Port ${port} is not available`);
      expect(await canBindPort(port)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
