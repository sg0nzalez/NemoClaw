// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LIVE_E2E_ROOT } from "../fixtures/paths.ts";

const REDUNDANT_LIVE_GATE =
  /shouldRunLiveE2E\s*\(|process\.env\.NEMOCLAW_RUN_LIVE_E2E\s*===\s*["']1["']/;

function liveTestFiles(): string[] {
  return fs
    .readdirSync(LIVE_E2E_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(LIVE_E2E_ROOT, entry.name));
}

describe("live E2E target gating", () => {
  it("leaves the default opt-in gate at Vitest project collection", () => {
    const violations = liveTestFiles()
      .filter((file) => REDUNDANT_LIVE_GATE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file));

    expect(violations).toEqual([]);
  });
});
