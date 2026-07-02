// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxBaseImageResolutionMetadata } from "../sandbox-base-image";
import {
  beginBaseImageResolutionFlow,
  getBaseImageResolutionPatchOptions,
  handoffRebuildBaseImageResolutionHint,
} from "./base-image-resolution-flow";
import { prepareSandboxDockerfilePatch } from "./sandbox-dockerfile-patch-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const sandboxGpuConfig: SandboxGpuConfig = {
  mode: "auto",
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

const resolutionMetadata: SandboxBaseImageResolutionMetadata = {
  schema: 1,
  key: "key",
  imageName: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc",
  digest: "sha256:abc",
  source: "version-tag",
  imageId: "sha256:image",
  os: "linux",
  architecture: "amd64",
  glibcVersion: "2.41",
  requireOpenshellSandboxAbi: true,
  minGlibcVersion: "2.39",
};

describe("prepareSandboxDockerfilePatch", () => {
  it("hands rebuild metadata into the next onboard flow and lets fresh bypass it (#4680)", () => {
    handoffRebuildBaseImageResolutionHint(resolutionMetadata);
    beginBaseImageResolutionFlow({ fresh: false, env: {} });
    expect(getBaseImageResolutionPatchOptions()).toMatchObject({
      resolutionHint: resolutionMetadata,
      forceBaseImageRefresh: false,
    });

    handoffRebuildBaseImageResolutionHint(resolutionMetadata);
    beginBaseImageResolutionFlow({ fresh: true, env: {} });
    expect(getBaseImageResolutionPatchOptions()).toMatchObject({
      resolutionHint: resolutionMetadata,
      forceBaseImageRefresh: true,
    });
    beginBaseImageResolutionFlow({ fresh: false, env: {} });
  });

  it("forwards a prior resolution hint, force refresh, and completed-image metadata (#4680)", async () => {
    const pullAndResolveBaseImageDigest = vi.fn(() => ({
      digest: resolutionMetadata.digest,
      ref: resolutionMetadata.ref,
      source: resolutionMetadata.source,
      glibcVersion: resolutionMetadata.glibcVersion,
      metadata: resolutionMetadata,
    }));
    const patchStagedDockerfile = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: resolutionMetadata.imageName,
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      resolutionHint: resolutionMetadata,
      forceBaseImageRefresh: true,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
        pullAndResolveBaseImageDigest,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(pullAndResolveBaseImageDigest).toHaveBeenCalledWith({
      requireOpenshellSandboxAbi: true,
      resolutionHint: resolutionMetadata,
      forceRefresh: true,
    });
    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      buildIdPolicy: "preserve",
      baseImageResolutionMetadata: resolutionMetadata,
    });
  });

  it("pins a resolved base image and patches the staged Dockerfile with the build id", async () => {
    const log = vi.fn();
    const patchStagedDockerfile = vi.fn();
    const enforceDockerGpuPatchPreserveNetwork = vi.fn(async () => false);
    const result = await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: "nvidia-prod",
      preferredInferenceApi: "chat",
      webSearchConfig: { fetchEnabled: true },
      hermesToolGateways: ["github"],
      sandboxGpuConfig,
      log,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
        pullAndResolveBaseImageDigest: vi.fn(() => ({
          digest: "sha256:abcdef0123456789",
          ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
        })),
        enforceDockerGpuPatchPreserveNetwork,
        patchStagedDockerfile,
        now: () => 12345,
      },
    });

    expect(result).toEqual({
      buildId: "12345",
      resolvedBaseImage: {
        digest: "sha256:abcdef0123456789",
        ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
      },
    });
    expect(log).toHaveBeenCalledWith("  Pinning base image to sha256:abcdef012345...");
    expect(enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
      "nvidia-prod",
      sandboxGpuConfig,
      {
        dockerDriverGateway: true,
        log,
      },
    );
    expect(patchStagedDockerfile).toHaveBeenCalledWith(
      "/tmp/Dockerfile",
      "model-a",
      "http://127.0.0.1:7000",
      "12345",
      "nvidia-prod",
      "chat",
      { fetchEnabled: true },
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abcdef0123456789",
      false,
      null,
      ["github"],
      { buildIdPolicy: "preserve" },
    );
  });

  it("skips base-image resolution for agent default Dockerfiles", async () => {
    const pullAndResolveBaseImageDigest = vi.fn();
    const dockerImageInspect = vi.fn();
    const patchStagedDockerfile = vi.fn();
    const result = await prepareSandboxDockerfilePatch({
      agent: { name: "hermes" } as any,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest,
        dockerImageInspect,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(result.resolvedBaseImage).toBeNull();
    expect(pullAndResolveBaseImageDigest).not.toHaveBeenCalled();
    expect(dockerImageInspect).not.toHaveBeenCalled();
    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      buildIdPolicy: "preserve",
    });
  });

  it("resolves the base image when an agent uses a custom Dockerfile", async () => {
    const pullAndResolveBaseImageDigest = vi.fn(() => ({
      digest: "sha256:customagent",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    }));
    const patchStagedDockerfile = vi.fn();

    const result = await prepareSandboxDockerfilePatch({
      agent: { name: "hermes" } as any,
      fromDockerfile: "/repo/Containerfile",
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      log: vi.fn(),
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest,
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(result.resolvedBaseImage).toEqual({
      digest: "sha256:customagent",
      ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    });
    expect(pullAndResolveBaseImageDigest).toHaveBeenCalledWith({
      requireOpenshellSandboxAbi: false,
    });
    expect(patchStagedDockerfile.mock.calls[0]?.[7]).toBe(
      "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:customagent",
    );
    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      buildIdPolicy: "rewrite",
    });
  });

  it("keeps the per-run rewrite for managed agents that consume the build id", async () => {
    const patchStagedDockerfile = vi.fn();

    await prepareSandboxDockerfilePatch({
      agent: { name: "langchain-deepagents-code" } as any,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile,
        now: () => 1,
      },
    });

    expect(patchStagedDockerfile.mock.calls[0]?.[11]).toEqual({
      buildIdPolicy: "rewrite",
    });
  });

  it("warns when the base image cannot be resolved but cached latest exists", async () => {
    const warn = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      warn,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest: vi.fn(() => null),
        dockerImageInspect: vi.fn(() => ({ status: 0 })),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile: vi.fn(),
        now: () => 1,
      },
    });

    expect(warn).toHaveBeenCalledWith(
      "  Warning: could not pull base image from registry; using cached :latest.",
    );
  });

  it("warns with a recovery command when the base image is unavailable", async () => {
    const warn = vi.fn();
    await prepareSandboxDockerfilePatch({
      agent: null,
      fromDockerfile: null,
      sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
      sandboxBaseTag: "latest",
      stagedDockerfile: "/tmp/Dockerfile",
      model: "model-a",
      chatUiUrl: "http://127.0.0.1:7000",
      provider: null,
      preferredInferenceApi: null,
      webSearchConfig: null,
      hermesToolGateways: [],
      sandboxGpuConfig,
      warn,
      deps: {
        isLinuxDockerDriverGatewayEnabled: vi.fn(() => false),
        pullAndResolveBaseImageDigest: vi.fn(() => null),
        dockerImageInspect: vi.fn(() => ({ status: 1 })),
        enforceDockerGpuPatchPreserveNetwork: vi.fn(async () => false),
        patchStagedDockerfile: vi.fn(),
        now: () => 1,
      },
    });

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "  Warning: base image ghcr.io/nvidia/nemoclaw/sandbox-base:latest is not available locally.",
      "  The build will fail unless Docker can pull the image during build.",
      "  If offline, pull the image manually first:",
      "    docker pull ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
    ]);
  });
});
