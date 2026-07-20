// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ForbiddenLeakPattern = [name: string, value: string];

export function bedrockRuntimeForbiddenLeakPatterns(options: {
  adapterToken: string;
  bedrockHostname: string;
  compatibleKey: string;
}): ForbiddenLeakPattern[] {
  return [
    ["fake user key", options.compatibleKey],
    ["adapter token", options.adapterToken],
    ["AWS bearer env name", "AWS_BEARER_TOKEN_BEDROCK"],
    ["raw Bedrock hostname", options.bedrockHostname],
  ];
}

export function findForbiddenLeaks(
  text: string,
  label: string,
  patterns: ForbiddenLeakPattern[],
): string[] {
  const locations: string[] = [];
  let current = label;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@NEMOCLAW_E2E_FILE@@ ")) {
      current = line.slice("@@NEMOCLAW_E2E_FILE@@ ".length);
      continue;
    }
    for (const [name, value] of patterns) {
      if (value && line.includes(value)) locations.push(`${name}: ${current}`);
    }
  }
  return [...new Set(locations)].sort();
}
