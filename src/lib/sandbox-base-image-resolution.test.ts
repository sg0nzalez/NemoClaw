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
    dockerMocks.imageInspectFormat.mockReturnValue(
      JSON.stringify({
        Id: IMAGE_ID,
        RepoDigests: [REF],
        Os: "linux",
        Architecture: "amd64",
      }),
    );
  });

  it("reuses locally proven RepoDigests metadata without inspecting candidates or pulling (#4680)", () => {
    dockerMocks.pull.mockImplementation(() => {
      throw new Error("network unavailable");
    });
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

  it("lets force refresh bypass a valid rebuild hint (#4680)", () => {
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
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });

    expect(
      resolveSandboxBaseImage({ ...options, resolutionHint: metadata, forceRefresh: true }),
    ).toBeNull();
    expect(dockerMocks.imageInspect).toHaveBeenCalled();
    expect(dockerMocks.pull).toHaveBeenCalled();
  });

  it("resolves an explicit override instead of reusing a stale default hint (#4680)", () => {
    const options = {
      ...resolutionOptions(),
      envVar: "NEMOCLAW_SANDBOX_BASE_IMAGE_REF",
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: REF,
      },
    };
    const staleHint: SandboxBaseImageResolutionMetadata = {
      schema: 1,
      key: "stale-default-key",
      imageName: IMAGE_NAME,
      ref: REF,
      digest: DIGEST,
      source: "latest",
      imageId: IMAGE_ID,
      os: "linux",
      architecture: "amd64",
      glibcVersion: null,
      requireOpenshellSandboxAbi: false,
      minGlibcVersion: OPENSHELL_SANDBOX_MIN_GLIBC,
    };
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });

    const resolved = resolveSandboxBaseImage({ ...options, resolutionHint: staleHint });

    expect(resolved).toMatchObject({ ref: REF, digest: DIGEST, source: "override" });
    expect(dockerMocks.pull).not.toHaveBeenCalled();
  });

  it("fails closed when offline and no cached image can be validated (#4680)", () => {
    dockerMocks.imageInspect.mockReturnValue({ status: 1 });
    dockerMocks.pull.mockReturnValue({ status: 1 });

    const resolved = resolveSandboxBaseImage({
      ...resolutionOptions(),
      env: {
        ...resolutionOptions().env,
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
    });

    expect(resolved).toBeNull();
    expect(dockerMocks.pull).toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("accepts a compatible local fallback when an ABI-required published image is incompatible (#4680)", () => {
    const rootDir = path.join(process.cwd(), ".missing-sandbox-base-image-resolution-root");
    const versionRef = `${IMAGE_NAME}:v1.2.3`;
    const latestRef = `${IMAGE_NAME}:latest`;
    const options = {
      ...resolutionOptions(),
      rootDir,
      dockerfilePath: path.join(rootDir, "Dockerfile.base"),
      env: {
        ...resolutionOptions().env,
        GITHUB_SHA: "",
        NEMOCLAW_SANDBOX_BASE_VERSION_TAG: "v1.2.3",
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
      requireOpenshellSandboxAbi: true,
    };
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });
    dockerMocks.capture
      .mockReturnValueOnce("ldd (GNU libc) GLIBC 2.38")
      .mockReturnValueOnce("ldd (GNU libc) GLIBC 2.38")
      .mockReturnValueOnce("ldd (GNU libc) GLIBC 2.39");

    const resolved = resolveSandboxBaseImage(options);

    expect(resolved).toMatchObject({
      ref: options.localTag,
      digest: null,
      source: "local",
      glibcVersion: "2.39",
      metadata: {
        ref: options.localTag,
        source: "local",
        glibcVersion: "2.39",
        requireOpenshellSandboxAbi: true,
      },
    });
    expect(dockerMocks.capture).toHaveBeenNthCalledWith(
      1,
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", versionRef, "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
    expect(dockerMocks.capture).toHaveBeenNthCalledWith(
      2,
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", latestRef, "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
    expect(dockerMocks.capture).toHaveBeenNthCalledWith(
      3,
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", options.localTag, "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });

  it("rejects an incompatible local fallback when an ABI-required published image is incompatible (#4680)", () => {
    const rootDir = path.join(process.cwd(), ".missing-sandbox-base-image-resolution-root");
    const versionRef = `${IMAGE_NAME}:v1.2.3`;
    const latestRef = `${IMAGE_NAME}:latest`;
    const options = {
      ...resolutionOptions(),
      rootDir,
      dockerfilePath: path.join(rootDir, "Dockerfile.base"),
      env: {
        ...resolutionOptions().env,
        GITHUB_SHA: "",
        NEMOCLAW_SANDBOX_BASE_VERSION_TAG: "v1.2.3",
        NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "0",
      },
      requireOpenshellSandboxAbi: true,
    };
    dockerMocks.imageInspect.mockReturnValue({ status: 0 });
    dockerMocks.capture
      .mockReturnValueOnce("ldd (GNU libc) GLIBC 2.38")
      .mockReturnValueOnce("ldd (GNU libc) GLIBC 2.38")
      .mockReturnValueOnce("ldd (GNU libc) GLIBC 2.38");

    const resolved = resolveSandboxBaseImage(options);

    expect(resolved).toBeNull();
    expect(dockerMocks.capture).toHaveBeenNthCalledWith(
      1,
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", versionRef, "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
    expect(dockerMocks.capture).toHaveBeenNthCalledWith(
      2,
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", latestRef, "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
    expect(dockerMocks.capture).toHaveBeenNthCalledWith(
      3,
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", options.localTag, "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
    expect(dockerMocks.pull).not.toHaveBeenCalled();
    expect(dockerMocks.build).not.toHaveBeenCalled();
  });
});
