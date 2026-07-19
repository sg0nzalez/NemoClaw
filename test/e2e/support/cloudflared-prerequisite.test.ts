// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readInferenceRoutingCloudflaredPin } from "../live/cloudflared-prerequisite.ts";

describe("inference-routing cloudflared prerequisite (#6141)", () => {
  it("reads the reviewed version and digest from the exact workflow", () => {
    expect(readInferenceRoutingCloudflaredPin()).toEqual({
      version: "2026.6.1",
      debSha256: "ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
    });
  });

  it("rejects a workflow without an immutable digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-pin-"));
    const workflow = path.join(root, "e2e.yaml");
    fs.writeFileSync(
      workflow,
      [
        "jobs:",
        "  inference-routing:",
        "    steps:",
        "      - name: Install and verify cloudflared prerequisite",
        "        env:",
        '          CLOUDFLARED_VERSION: "2026.6.1"',
        '          CLOUDFLARED_DEB_SHA256: "mutable"',
        "",
      ].join("\n"),
    );
    try {
      expect(() => readInferenceRoutingCloudflaredPin(workflow)).toThrow(
        "inference-routing cloudflared SHA256 pin is missing or invalid",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
