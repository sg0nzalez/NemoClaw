// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createSandboxBaseImageResolutionKey } from "./resolution-key";

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resolution-key-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "nemoclaw-blueprint"), { recursive: true });
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM node:22\n");
  fs.writeFileSync(path.join(root, "nemoclaw-blueprint", "blueprint.yaml"), "version: 1\n");
  return root;
}

function options(root: string) {
  return {
    imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
    dockerfilePath: path.join(root, "Dockerfile.base"),
    localTag: "nemoclaw-sandbox-base-local:test",
    rootDir: root,
    env: { GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678" },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sandbox base-image resolution key", () => {
  it("changes when a relevant base input changes (#4680)", () => {
    const root = fixture();
    const before = createSandboxBaseImageResolutionKey(options(root));
    fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM node:22\nRUN echo changed\n");
    expect(createSandboxBaseImageResolutionKey(options(root))).not.toBe(before);
  });

  it("isolates explicit base-image overrides (#4680)", () => {
    const root = fixture();
    const base = { ...options(root), envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF" };
    const first = createSandboxBaseImageResolutionKey({
      ...base,
      env: { ...base.env, NEMOCLAW_SANDBOX_BASE_IMAGE_REF: "example/base@sha256:first" },
    });
    const second = createSandboxBaseImageResolutionKey({
      ...base,
      env: { ...base.env, NEMOCLAW_SANDBOX_BASE_IMAGE_REF: "example/base@sha256:second" },
    });
    expect(second).not.toBe(first);
  });
});
