// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent, withMockedDocker } from "../../../test/helpers/base-image-test-harness";

describe("agent base image provisioning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("probes resolved Hermes bases for the pinned version and native MCP runtime", () => {
    withMockedDocker(({ ensureAgentBaseImage, dockerCaptureMock, resolveSandboxBaseImageMock }) => {
      const compatibleOutputByEntrypoint = new Map([
        ["/usr/local/bin/hermes", "Hermes Agent v0.18.0 (2026.7.1)"],
        ["/opt/hermes/.venv/bin/python", "nemoclaw-hermes-mcp-runtime-ok"],
      ]);
      dockerCaptureMock.mockImplementation(
        (args: string[]) => compatibleOutputByEntrypoint.get(args[3]) ?? "",
      );
      ensureAgentBaseImage(makeAgent());
      const options = resolveSandboxBaseImageMock.mock.calls[0]?.[0] as {
        validateImage?: (imageRef: string) => boolean;
      };

      const compatibleLocalRef = "nemoclaw-hermes-sandbox-base-local:test";
      expect(options.validateImage?.(compatibleLocalRef)).toBe(true);
      expect(dockerCaptureMock).toHaveBeenCalledWith(
        ["run", "--rm", "--entrypoint", "/usr/local/bin/hermes", compatibleLocalRef, "--version"],
        { ignoreError: true, timeout: 20_000 },
      );
      expect(dockerCaptureMock).toHaveBeenCalledWith(
        [
          "run",
          "--rm",
          "--entrypoint",
          "/opt/hermes/.venv/bin/python",
          compatibleLocalRef,
          "-c",
          expect.stringContaining("_MCP_HTTP_AVAILABLE"),
        ],
        { ignoreError: true, timeout: 20_000 },
      );

      dockerCaptureMock.mockImplementation((args: string[]) =>
        args[3] === "/usr/local/bin/hermes" ? "Hermes Agent v0.17.0 (2026.6.19)" : "",
      );
      const staleLocalRef = "nemoclaw-hermes-sandbox-base-local:stale";
      expect(options.validateImage?.(staleLocalRef)).toBe(false);
      expect(dockerCaptureMock).not.toHaveBeenCalledWith(
        expect.arrayContaining([staleLocalRef, "/opt/hermes/.venv/bin/python"]),
        expect.anything(),
      );

      dockerCaptureMock.mockClear();
      dockerCaptureMock.mockImplementation(
        (args: string[]) => compatibleOutputByEntrypoint.get(args[3]) ?? "",
      );
      expect(
        options.validateImage?.(
          `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
        ),
      ).toBe(true);
      expect(dockerCaptureMock).toHaveBeenCalled();

      dockerCaptureMock.mockClear();
      expect(options.validateImage?.("ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest")).toBe(
        false,
      );
      expect(dockerCaptureMock).not.toHaveBeenCalled();
    });
  });

  it("accepts only the tracked published Hermes base digest", () => {
    const dockerfilePath = path.resolve(import.meta.dirname, "../../../agents/hermes/Dockerfile");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const trackedRef = dockerfile.match(
      /^ARG BASE_IMAGE=(ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@(sha256:[0-9a-f]{64}))$/m,
    );
    expect(trackedRef).not.toBeNull();

    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: trackedRef?.[1],
        digest: trackedRef?.[2],
        source: "source-sha",
        glibcVersion: "2.41",
      });

      expect(ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toEqual({
        imageTag: trackedRef?.[1],
        built: false,
      });
      expect(resolveSandboxBaseImageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pinnedRemoteRef: trackedRef?.[1],
          preferPinnedRemoteRef: true,
        }),
      );

      const platformDigest =
        "sha256:c0c149ed03b3e8fcd3e395558b22e871cd27c9966ea6faf04c0d2b94d0a821b9";
      const platformDigestRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${platformDigest}`;
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: platformDigestRef,
        digest: platformDigest,
        source: "pinned",
        pinnedRemoteRef: trackedRef?.[1],
        glibcVersion: "2.41",
      });
      expect(ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toEqual({
        imageTag: platformDigestRef,
        built: false,
      });

      const wrongNamespaceRef = `ghcr.io/nvidia/nemoclaw/other-hermes-base@${platformDigest}`;
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: wrongNamespaceRef,
        digest: platformDigest,
        source: "pinned",
        pinnedRemoteRef: trackedRef?.[1],
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );

      resolveSandboxBaseImageMock.mockReturnValue({
        ref: platformDigestRef,
        digest: platformDigest,
        source: "latest",
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );

      resolveSandboxBaseImageMock.mockReturnValue({
        ref: platformDigestRef,
        digest: platformDigest,
        source: "pinned",
        pinnedRemoteRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"2".repeat(64)}`,
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );

      const differentRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"0".repeat(64)}`;
      resolveSandboxBaseImageMock.mockReturnValue({
        ref: differentRef,
        digest: `sha256:${"0".repeat(64)}`,
        source: "source-sha",
        glibcVersion: "2.41",
      });
      expect(() => ensureAgentBaseImage(makeAgent({ dockerfilePath }))).toThrow(
        "Hermes final image does not accept base image ref",
      );
    });
  });

  it("fails before candidate resolution when the Hermes final Dockerfile is unreadable", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      expect(() =>
        ensureAgentBaseImage(makeAgent({ dockerfilePath: "/missing/hermes/Dockerfile" })),
      ).toThrow("Failed to read Hermes final Dockerfile");
      expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
    });
  });

  it("fails a forced rebuild before deletion when the built base fails validation", () => {
    withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
      resolveSandboxBaseImageMock.mockReturnValue(null);

      expect(() => ensureAgentBaseImage(makeAgent(), { forceBaseImageRebuild: true })).toThrow(
        "failed the required runtime compatibility checks",
      );
    });
  });

  it("validates an explicit override strictly instead of falling back", () => {
    const envVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const prior = process.env[envVar];
    process.env[envVar] = "localhost:5000/custom/hermes:latest";
    try {
      withMockedDocker(({ ensureAgentBaseImage, resolveSandboxBaseImageMock }) => {
        resolveSandboxBaseImageMock.mockReturnValue({
          ref: process.env[envVar],
          digest: null,
          source: "override",
          glibcVersion: "2.41",
        });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "Hermes final image does not accept base image ref",
        );
        expect(resolveSandboxBaseImageMock).not.toHaveBeenCalled();
      });
    } finally {
      prior === undefined ? delete process.env[envVar] : (process.env[envVar] = prior);
    }
  });

  it("fails closed when no version-matched, MCP-capable Hermes base image can be resolved", () => {
    withMockedDocker(
      ({
        ensureAgentBaseImage,
        dockerBuildMock,
        dockerImageInspectMock,
        resolveSandboxBaseImageMock,
      }) => {
        resolveSandboxBaseImageMock.mockReturnValue(null);
        dockerImageInspectMock.mockReturnValue({ status: 1 });

        expect(() => ensureAgentBaseImage(makeAgent())).toThrow(
          "No compatible Hermes Agent sandbox base image found",
        );
        expect(dockerBuildMock).not.toHaveBeenCalled();
        expect(dockerImageInspectMock).not.toHaveBeenCalled();
      },
    );
  });
});
