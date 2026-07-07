// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../src/lib/core/shell-quote";

export type BrevVitestProject = "cli" | "e2e-live";

export const BREV_SECURITY_SUITE_TIMEOUT_MS = 20 * 60_000;
export const BREV_MESSAGING_PROVIDER_TIMEOUT_MS = 70 * 60_000;
export const BREV_MESSAGING_COMPAT_TIMEOUT_MS = 40 * 60_000;
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_TIMEOUT_MS = 55 * 60_000;
export const BREV_REMOTE_WRAPPER_GRACE_MS = 120_000;
export const BREV_WORKFLOW_OWNERSHIP_ENV = "NEMOCLAW_BREV_WORKFLOW_OWNS_INSTANCE";
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE = "tool-disclosure-performance-smoke";
export const BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_ARTIFACT_DIR =
  "/tmp/nemoclaw-tool-disclosure-performance-smoke-artifacts";
export const BREV_CLOUDFLARED_VERSION = "2026.6.1";
export const BREV_CLOUDFLARED_DEB_SHA256 =
  "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526";

const BREV_SUITES_WITHOUT_HARNESS_SANDBOX = new Set([
  "all",
  "full",
  "gpu",
  "messaging-compatible-endpoint",
  "messaging-providers",
  BREV_TOOL_DISCLOSURE_PERFORMANCE_SMOKE_SUITE,
]);

export function brevSuiteNeedsHarnessSandbox(testSuite: string): boolean {
  return !BREV_SUITES_WITHOUT_HARNESS_SANDBOX.has(testSuite);
}

export function brevSuiteHarnessSandboxName(testSuite: string): string | undefined {
  return brevSuiteNeedsHarnessSandbox(testSuite) ? "e2e-test" : undefined;
}

export function brevWorkflowOwnsInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BREV_WORKFLOW_OWNERSHIP_ENV] === "1";
}

export function buildBrevRemoteVitestCommand(project: BrevVitestProject, target: string): string {
  const vitestCommand = [
    "./node_modules/.bin/vitest",
    "run",
    "--project",
    project,
    target,
    "--silent=false",
    "--reporter=default",
  ]
    .map(shellQuote)
    .join(" ");

  return [
    // A nested live installer test may run npm link and prune the repository's
    // dev dependencies. Restore the reviewed lockfile graph before the next
    // remote suite, with lifecycle scripts disabled, instead of letting npx
    // download an unpinned replacement.
    "if [ ! -x ./node_modules/.bin/vitest ]; then npm ci --ignore-scripts --no-audit --no-fund; fi",
    "test -x ./node_modules/.bin/vitest",
    `NEMOCLAW_RUN_LIVE_E2E=1 ${vitestCommand}`,
  ].join(" && ");
}

export function buildBrevCloudflaredInstallCommands(): string[] {
  return [
    "set -euo pipefail",
    `cloudflared_deb=/tmp/cloudflared-${BREV_CLOUDFLARED_VERSION}-linux-amd64.deb`,
    `curl -fL https://github.com/cloudflare/cloudflared/releases/download/${BREV_CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb -o \"$cloudflared_deb\"`,
    `printf '%s  %s\\n' ${BREV_CLOUDFLARED_DEB_SHA256} \"$cloudflared_deb\" | sha256sum -c -`,
    `test \"$(dpkg-deb -f \"$cloudflared_deb\" Package)\" = cloudflared`,
    `test \"$(dpkg-deb -f \"$cloudflared_deb\" Version)\" = ${BREV_CLOUDFLARED_VERSION}`,
    `test \"$(dpkg-deb -f \"$cloudflared_deb\" Architecture)\" = amd64`,
    `sudo dpkg -i \"$cloudflared_deb\"`,
    `cloudflared --version | grep -F 'cloudflared version ${BREV_CLOUDFLARED_VERSION}'`,
  ];
}
