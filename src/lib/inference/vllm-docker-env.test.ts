// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalDualStationDockerEnv,
  buildRemoteVllmDockerEnv,
  buildVllmDockerEnv,
} from "./vllm-docker-env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed vLLM Docker client environment", () => {
  it("forwards one Docker context while retaining subprocess secret filtering (#6757)", () => {
    vi.stubEnv("DOCKER_CONFIG", "/tmp/nemoclaw-docker-config");
    vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
    vi.stubEnv("DOCKER_HOST", "ssh://fallback.example.test");
    vi.stubEnv("DOCKER_TLS", "1");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const env = buildVllmDockerEnv({ HF_TOKEN: "hf_test" });

    expect(env).toEqual(
      expect.objectContaining({
        DOCKER_CONFIG: "/tmp/nemoclaw-docker-config",
        DOCKER_CONTEXT: "remote-builder",
        DOCKER_HOST: "ssh://fallback.example.test",
        DOCKER_TLS: "1",
        HF_TOKEN: "hf_test",
      }),
    );
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it("does not inherit Docker selectors omitted from an explicit source (#6757)", () => {
    vi.stubEnv("DOCKER_HOST", "ssh://ambient.example.test");

    const env = buildVllmDockerEnv({}, { DOCKER_CONTEXT: "requested-context" });

    expect(env.DOCKER_CONTEXT).toBe("requested-context");
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it("pins a canonical SSH daemon and strips incompatible ambient Docker selectors", () => {
    vi.stubEnv("DOCKER_API_VERSION", "1.48");
    vi.stubEnv("DOCKER_CERT_PATH", "/tmp/ambient-docker-certs");
    vi.stubEnv("DOCKER_CONFIG", "/tmp/nemoclaw-docker-config");
    vi.stubEnv("DOCKER_CONTEXT", "ambient-context");
    vi.stubEnv("DOCKER_HOST", "tcp://ambient.example.test:2376");
    vi.stubEnv("DOCKER_TLS", "1");
    vi.stubEnv("DOCKER_TLS_VERIFY", "1");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "must-not-cross-ssh");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const env = buildRemoteVllmDockerEnv("ssh://station@dgx-peer.example.test:22");

    expect(env).toEqual(
      expect.objectContaining({
        DOCKER_HOST: "ssh://station@dgx-peer.example.test:22",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      }),
    );
    expect(env.DOCKER_API_VERSION).toBeUndefined();
    expect(env.DOCKER_CERT_PATH).toBeUndefined();
    expect(env.DOCKER_CONFIG).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.DOCKER_TLS).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(env.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
  });

  it("pins the dual-Station head to the physical host default Docker daemon", () => {
    const env = buildLocalDualStationDockerEnv(
      { SAFE_MARKER: "kept" },
      {
        DOCKER_HOST: "ssh://wrong-daemon",
        DOCKER_CONTEXT: "wrong-context",
        DOCKER_CONFIG: "/tmp/wrong-config",
      },
    );

    expect(env.SAFE_MARKER).toBe("kept");
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBe("default");
    expect(env.DOCKER_CONFIG).toBeUndefined();
  });

  it.each([
    "tcp://dgx-peer.example.test:2376",
    "ssh://station:secret@dgx-peer.example.test",
    "ssh://dgx-peer.example.test/",
    "ssh://dgx-peer.example.test?context=other",
    "ssh://Dgx-Peer.example.test",
    " ssh://dgx-peer.example.test",
  ])("rejects a non-canonical or unsafe remote Docker target: %s", (sshUri) => {
    expect(() => buildRemoteVllmDockerEnv(sshUri)).toThrow(
      "Remote Docker host must be a canonical ssh://[user@]host[:port] URI",
    );
  });
});
