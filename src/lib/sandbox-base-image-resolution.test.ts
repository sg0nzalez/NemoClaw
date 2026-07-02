// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  build: vi.fn(),
  capture: vi.fn(),
  imageInspect: vi.fn(),
  imageInspectFormat: vi.fn(),
  infoFormat: vi.fn(),
  pull: vi.fn(),
}));

vi.mock("./adapters/docker", () => ({
  dockerBuild: dockerMocks.build,
  dockerCapture: dockerMocks.capture,
  dockerImageInspect: dockerMocks.imageInspect,
  dockerImageInspectFormat: dockerMocks.imageInspectFormat,
  dockerInfoFormat: dockerMocks.infoFormat,
  dockerPull: dockerMocks.pull,
}));

import {
  createSandboxBaseImageResolutionKey,
  OPENSHELL_SANDBOX_MIN_GLIBC,
  resolveSandboxBaseImage,
  type SandboxBaseImageResolutionMetadata,
} from "./sandbox-base-image";

const IMAGE_NAME = "ghcr.io/nvidia/nemoclaw/sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = `${IMAGE_NAME}@${DIGEST}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function resolutionOptions() {
  return {
    imageName: IMAGE_NAME,
    dockerfilePath: path.join(process.cwd(), "Dockerfile.base"),
    localTag: "nemoclaw-sandbox-base-local:test",
    rootDir: process.cwd(),
    env: {
      ...process.env,
      GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    },
    requireOpenshellSandboxAbi: false,
  };
}

describe("sandbox base-image warm resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.infoFormat.mockReturnValue("linux/amd64\n");
    dockerMocks.imageInspectFormat.mockImplementation((format: string) => {
      if (format !== "{{json .}}") return "";
      return JSON.stringify({
        Id: IMAGE_ID,
        RepoDigests: [REF],
        Os: "linux",
        Architecture: "amd64",
      });
    });
  });

  it("reuses locally proven RepoDigests metadata without inspecting candidates or pulling (#4680)", () => {
    const options = resolutionOptions();
    const metadata: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: createSandboxBaseImageResolutionKey(options),
      imageName: IMAGE_NAME,
      ref: REF,
      digest: DIGEST,
      source: "version-tag",
      imageId: IMAGE_ID,
      os: "linux",
      architecture: "amd64",
      glibcVersion: null,
      requireOpenshellSandboxAbi: false,
      minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
    };

    const resolved = resolveSandboxBaseImage({ ...options, resolutionHint: metadata });

    expect(resolved).toEqual({
      ref: REF,
      digest: DIGEST,
      source: "version-tag",
      glibcVersion: null,
      metadata,
    });
    expect(dockerMocks.imageInspectFormat).toHaveBeenCalledTimes(1);
    expect(dockerMocks.imageInspect).not.toHaveBeenCalled();
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
    expect(dockerMocks.capture).not.toHaveBeenCalled();
  });
});
