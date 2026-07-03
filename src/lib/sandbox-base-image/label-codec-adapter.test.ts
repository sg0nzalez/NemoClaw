// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  imageInspectFormat: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerImageInspectFormat: dockerMocks.imageInspectFormat,
}));

import { readSandboxBaseImageResolutionMetadata } from "./label-codec";
import { SANDBOX_BASE_RESOLUTION_LABEL, type SandboxBaseImageResolutionMetadata } from "./types";

const IMAGE_REF = "nemoclaw-managed:test";
const metadata: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: "resolution-key",
  imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
  digest: "sha256:abc",
  source: "version-tag",
  imageId: "sha256:image-id",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

function labelsOutput(encoded: string): string {
  return JSON.stringify({ [SANDBOX_BASE_RESOLUTION_LABEL]: encoded });
}

function encodedMetadata(): string {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
}

describe("sandbox base-image resolution label adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads valid resolution metadata from Docker image labels (#4680)", () => {
    dockerMocks.imageInspectFormat.mockReturnValue(labelsOutput(encodedMetadata()));

    expect(readSandboxBaseImageResolutionMetadata(IMAGE_REF)).toEqual(metadata);
    expect(dockerMocks.imageInspectFormat).toHaveBeenCalledWith(
      "{{json .Config.Labels}}",
      IMAGE_REF,
      { ignoreError: true },
    );
  });

  it("does not inspect Docker when the managed image reference is absent (#4680)", () => {
    expect(readSandboxBaseImageResolutionMetadata(null)).toBeNull();
    expect(dockerMocks.imageInspectFormat).not.toHaveBeenCalled();
  });

  it("ignores an absent Docker label response (#4680)", () => {
    dockerMocks.imageInspectFormat.mockReturnValue(null);

    expect(readSandboxBaseImageResolutionMetadata(IMAGE_REF)).toBeNull();
  });

  it("ignores malformed base-resolution labels from Docker inspect (#4680)", () => {
    dockerMocks.imageInspectFormat.mockReturnValue(labelsOutput("not+base64url/payload="));

    expect(readSandboxBaseImageResolutionMetadata(IMAGE_REF)).toBeNull();
  });

  it("ignores non-JSON Docker inspect output (#4680)", () => {
    dockerMocks.imageInspectFormat.mockReturnValue("not-json");

    expect(readSandboxBaseImageResolutionMetadata(IMAGE_REF)).toBeNull();
  });

  it("rejects oversized Docker label payloads before decoding (#4680)", () => {
    dockerMocks.imageInspectFormat.mockReturnValue(labelsOutput("a".repeat(20_000)));

    expect(readSandboxBaseImageResolutionMetadata(IMAGE_REF)).toBeNull();
  });
});
