// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { redact } from "../security/redact";

import type { ChildExitState } from "./child-exit-tracker";

export type ReportPodmanDriverGatewayStartFailureOpts = {
  exitOnFailure: boolean;
  socketPath: string;
};

function readLogTail(logPath: string): string {
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).slice(-20).join("\n")
    : "";
}

function isPodmanSocketConnectionRefused(tail: string): boolean {
  return /podman\.sock.*connection refused|connection refused.*podman\.sock/i.test(tail);
}

function isPodmanSocketMissing(tail: string): boolean {
  return /podman socket not found|podman\.sock.*no such file|no such file.*podman\.sock/i.test(
    tail,
  );
}

function isPodmanCgroupsV1(tail: string): boolean {
  return /cgroups v2 is required|detected cgroups ['"]?v?1/i.test(tail);
}

export function reportPodmanDriverGatewayStartFailure(
  logPath: string,
  childExit: ChildExitState,
  { exitOnFailure, socketPath }: ReportPodmanDriverGatewayStartFailureOpts,
): void {
  const tail = readLogTail(logPath);

  console.error("  OpenShell Podman-driver gateway failed to start.");
  if (childExit.exited) {
    console.error(`  Gateway process ${childExit.describeExit()} before becoming ready.`);
  } else {
    console.error("  The gateway process did not become healthy within the timeout.");
  }

  if (tail) {
    console.error("  Gateway log tail:");
    for (const line of tail.split("\n")) console.error(`    ${redact(line)}`);
  }

  if (isPodmanSocketConnectionRefused(tail)) {
    console.error("");
    console.error("  Root cause: the rootless Podman API socket refused connections.");
    console.error("  Restart the user Podman socket, verify it, then rerun onboarding:");
    console.error("    systemctl --user restart podman.socket");
    console.error(`    podman --url unix://${socketPath} info`);
  } else if (isPodmanSocketMissing(tail)) {
    console.error("");
    console.error("  Root cause: the rootless Podman API socket was not found.");
    console.error("  Start the user Podman socket, verify it, then rerun onboarding:");
    console.error("    systemctl --user enable --now podman.socket");
    console.error(`    podman --url unix://${socketPath} info`);
  } else if (isPodmanCgroupsV1(tail)) {
    console.error("");
    console.error("  Root cause: rootless Podman requires cgroups v2 for this gateway runtime.");
    console.error("  Verify `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs` before retrying.");
  }

  console.error("  Troubleshooting:");
  console.error(`    tail -100 ${logPath}`);
  console.error(`    podman --url unix://${socketPath} info`);
  console.error("    openshell gateway info");
  console.error("    openshell status");

  if (exitOnFailure) {
    process.exit(1);
  }
}
