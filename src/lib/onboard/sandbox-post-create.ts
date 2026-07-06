// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentLandlockCompatibility } from "../agent/definition-types";
import { warnIfLandlockUnsupported } from "./landlock-warning";
import { applyOnboardVmDnsMonkeypatch } from "./vm-dns-monkeypatch";

type RestoreResult = {
  success: boolean;
  restoredDirs: unknown[];
  restoredFiles: unknown[];
};

type RunFile = (command: string, args: string[], options?: { ignoreError?: boolean }) => unknown;

export type SandboxPostCreateOptions = {
  sandboxName: string;
  restoreBackupPath?: string | null;
  pendingStateRestoreBackupPath?: string | null;
  restoreSandboxState: (sandboxName: string, backupPath: string) => RestoreResult;
  note: (message: string) => void;
  runtimeFields: { openshellDriver?: string | null };
  runFile: RunFile;
  dnsProxyScriptPath: string;
  gatewayName: string;
  messagingProviders: string[];
  providerExistsInGateway: (name: string) => boolean;
  printMessagingProviderMissing: (name: string) => void;
  landlockCompatibility?: AgentLandlockCompatibility;
  dockerInfoFormat: (format: string, options?: { ignoreError?: boolean }) => string;
  runCapture: (args: string[], options?: { ignoreError?: boolean }) => string;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export function runSandboxPostCreateSteps({
  sandboxName,
  restoreBackupPath,
  pendingStateRestoreBackupPath,
  restoreSandboxState,
  note,
  runtimeFields,
  runFile,
  dnsProxyScriptPath,
  gatewayName,
  messagingProviders,
  providerExistsInGateway,
  printMessagingProviderMissing,
  landlockCompatibility = "best_effort",
  dockerInfoFormat,
  runCapture,
  log = console.log,
  error = console.error,
}: SandboxPostCreateOptions): void {
  if (restoreBackupPath) {
    note(
      pendingStateRestoreBackupPath
        ? "  Restoring workspace state from pre-upgrade backup..."
        : "  Restoring workspace state from pre-recreate backup...",
    );
    const restore = restoreSandboxState(sandboxName, restoreBackupPath);
    if (restore.success) {
      note(
        `  ✓ State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    } else {
      error(`  Warning: partial restore. Manual recovery: ${restoreBackupPath}`);
    }
  }

  if (runtimeFields.openshellDriver === "kubernetes") {
    log("  Setting up sandbox DNS proxy...");
    runFile("bash", [dnsProxyScriptPath, gatewayName, sandboxName], { ignoreError: true });
  }

  applyOnboardVmDnsMonkeypatch(sandboxName, runtimeFields);

  for (const provider of messagingProviders) {
    if (!providerExistsInGateway(provider)) {
      printMessagingProviderMissing(provider);
    }
  }

  log(`  ✓ Sandbox '${sandboxName}' created`);
  warnIfLandlockUnsupported({
    compatibility: landlockCompatibility,
    dockerInfoFormat,
    runCapture,
  });
}
