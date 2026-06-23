// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CURL_AUTH_CONFIG_PREFIX = "nemoclaw-auth-curl";

function quoteCurlConfigValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

export function createAuthCurlConfig(
  headerValue: string,
  prefix = DEFAULT_CURL_AUTH_CONFIG_PREFIX,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  try {
    fs.chmodSync(dir, 0o700);
    const configPath = path.join(dir, "auth.conf");
    fs.writeFileSync(configPath, `header = "${quoteCurlConfigValue(headerValue)}"\n`, {
      mode: 0o600,
      encoding: "utf8",
    });
    return configPath;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupAuthCurlConfig(
  configPath: string,
  prefix = DEFAULT_CURL_AUTH_CONFIG_PREFIX,
): void {
  const dir = path.dirname(configPath);
  if (dir !== os.tmpdir() && path.basename(dir).startsWith(`${prefix}-`)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
