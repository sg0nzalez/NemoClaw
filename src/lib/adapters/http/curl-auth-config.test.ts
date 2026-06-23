// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupAuthCurlConfig,
  createAuthCurlConfig,
} from "../../../../dist/lib/adapters/http/curl-auth-config";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const dir of cleanupPaths.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("auth curl config helpers", () => {
  it("cleans up auth config directories created below the temp root", () => {
    const configPath = createAuthCurlConfig("Authorization: Bearer nvapi-x", "nemoclaw-auth-test");
    const dir = path.dirname(configPath);

    expect(fs.existsSync(configPath)).toBe(true);

    cleanupAuthCurlConfig(configPath, "nemoclaw-auth-test");

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does not remove a matching directory outside the temp root", () => {
    const parentDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-nemoclaw-auth-parent-"));
    const outsideDir = path.join(parentDir, "nemoclaw-auth-test-stale");
    cleanupPaths.push(parentDir);
    fs.mkdirSync(outsideDir);
    const configPath = path.join(outsideDir, "auth.conf");
    fs.writeFileSync(configPath, "header = \"Authorization: Bearer nvapi-x\"\n", {
      mode: 0o600,
      encoding: "utf8",
    });

    cleanupAuthCurlConfig(configPath, "nemoclaw-auth-test");

    expect(fs.existsSync(outsideDir)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("rejects path-like temp prefixes", () => {
    expect(() => createAuthCurlConfig("Authorization: Bearer nvapi-x", "nested/prefix")).toThrow(
      /Invalid temp file prefix/,
    );
    expect(() =>
      cleanupAuthCurlConfig(
        path.join(os.tmpdir(), "nested", "prefix-stale", "auth.conf"),
        "nested/prefix",
      ),
    ).toThrow(/Invalid temp file prefix/);
  });
});
