// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const LIVE_ROOT = path.resolve(import.meta.dirname, "../live");
const LOCAL_COMMAND_HELPER =
  /^(?:export\s+)?(?:function\s+(?:resultText|expectExitZero)\s*\(|const\s+(?:resultText|expectExitZero)\s*=)/m;

function typescriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}

describe("E2E command helper adoption", () => {
  it("keeps live targets on the shared command result helpers", () => {
    const violations = typescriptFiles(LIVE_ROOT)
      .filter((file) => LOCAL_COMMAND_HELPER.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(LIVE_ROOT, file));

    expect(violations).toEqual([]);
  });
});
