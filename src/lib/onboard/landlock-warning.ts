// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function parseKernelMajorMinor(value: string): { major: number; minor: number } | null {
  const parts = value.split(".");
  const major = parseInt(parts[0] ?? "", 10);
  const minor = parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  return { major, minor };
}

function unsupportedLandlockMessage(kernel: string, label: string): string | null {
  const parsed = parseKernelMajorMinor(kernel);
  if (!parsed || parsed.major > 5 || (parsed.major === 5 && parsed.minor >= 13)) return null;
  return `Landlock: ${label} ${kernel} does not support Landlock (requires >=5.13).`;
}

export function warnIfLandlockUnsupported({
  platform = process.platform,
  dockerInfoFormat,
  runCapture,
  warn = console.warn,
}: {
  platform?: NodeJS.Platform;
  dockerInfoFormat: (format: string, options?: { ignoreError?: boolean }) => string;
  runCapture: (args: string[], options?: { ignoreError?: boolean }) => string;
  warn?: (message: string) => void;
}): void {
  let unsupportedMessage: string | null = null;
  try {
    if (platform === "darwin") {
      const vmKernel = dockerInfoFormat("{{.KernelVersion}}", { ignoreError: true }).trim();
      if (vmKernel) unsupportedMessage = unsupportedLandlockMessage(vmKernel, "Docker VM kernel");
    } else if (platform === "linux") {
      const uname = runCapture(["uname", "-r"], { ignoreError: true }).trim();
      if (uname) unsupportedMessage = unsupportedLandlockMessage(uname, "Kernel");
    }
  } catch {
    warn("  Warning: could not verify Landlock kernel support.");
  }
  if (unsupportedMessage) {
    throw new Error(
      [
        unsupportedMessage,
        "NemoClaw onboard requires fail-closed filesystem isolation and will not create or reuse a sandbox in best_effort Landlock mode.",
        "Run on Linux kernel 5.13 or later with Landlock enabled, then retry `nemoclaw onboard`.",
      ].join("\n"),
    );
  }
}
