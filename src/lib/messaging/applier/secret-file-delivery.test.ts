// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ChannelManifest } from "../manifest";
import {
  collectMessagingSecretFiles,
  deliverMessagingSecretFiles,
  type MessagingSecretFileTarget,
  type SecretFileDeliveryDeps,
} from "./secret-file-delivery";

const SA_TARGET = "/sandbox/.openclaw/secrets/googlechat-service-account.json";

const GOOGLECHAT_TARGET: MessagingSecretFileTarget = {
  channelId: "googlechat",
  secretFileId: "serviceAccountFile",
  envKey: "GOOGLECHAT_SERVICE_ACCOUNT",
  target: SA_TARGET,
  mode: "640",
};

function makeDeps(overrides: Partial<SecretFileDeliveryDeps> = {}): SecretFileDeliveryDeps {
  return {
    readSecret: vi.fn(() => '{"type":"service_account"}'),
    uploadToSandbox: vi.fn(() => true),
    execInSandbox: vi.fn(() => true),
    restartGateway: vi.fn(),
    log: () => {},
    warn: () => {},
    writeTempFile: vi.fn(() => "/tmp/nemoclaw-secret-x/secret"),
    removeTempFile: vi.fn(),
    ...overrides,
  };
}

// Synthetic manifest exercising the generic secret-file delivery contract.
// Google Chat itself no longer ships secretFiles (its service account is minted
// gateway-side and the key never enters the sandbox), so the delivery path is
// covered here with a fixture rather than a built-in manifest.
const FIXTURE_MANIFEST = {
  id: "googlechat",
  inputs: [
    { id: "serviceAccount", kind: "secret", required: true, envKey: "GOOGLECHAT_SERVICE_ACCOUNT" },
  ],
  secretFiles: [
    {
      id: "serviceAccountFile",
      sourceInput: "serviceAccount",
      agent: "openclaw",
      target: SA_TARGET,
      mode: "640",
    },
  ],
} as unknown as ChannelManifest;

describe("collectMessagingSecretFiles", () => {
  it("maps a service-account file from a manifest's secretFiles", () => {
    expect(collectMessagingSecretFiles([FIXTURE_MANIFEST], ["googlechat"], "openclaw")).toEqual([
      GOOGLECHAT_TARGET,
    ]);
  });

  it("skips inactive channels and non-matching agents", () => {
    expect(collectMessagingSecretFiles([FIXTURE_MANIFEST], [], "openclaw")).toEqual([]);
    expect(collectMessagingSecretFiles([FIXTURE_MANIFEST], ["googlechat"], "hermes")).toEqual([]);
  });
});

describe("deliverMessagingSecretFiles", () => {
  it("uploads, chmods, and restarts the gateway once on success", () => {
    const deps = makeDeps();
    const result = deliverMessagingSecretFiles("sbx", [GOOGLECHAT_TARGET], deps);

    expect(result.delivered).toEqual(["serviceAccountFile"]);
    expect(result.skipped).toEqual([]);
    expect(deps.uploadToSandbox).toHaveBeenCalledWith(
      "sbx",
      "/tmp/nemoclaw-secret-x/secret",
      SA_TARGET,
    );
    expect(deps.execInSandbox).toHaveBeenCalledWith("sbx", ["chmod", "640", SA_TARGET]);
    expect(deps.restartGateway).toHaveBeenCalledTimes(1);
    expect(deps.removeTempFile).toHaveBeenCalledWith("/tmp/nemoclaw-secret-x/secret");
  });

  it("skips and does not restart when the secret is unavailable", () => {
    const deps = makeDeps({ readSecret: vi.fn(() => null) });
    const result = deliverMessagingSecretFiles("sbx", [GOOGLECHAT_TARGET], deps);

    expect(result.skipped).toEqual(["serviceAccountFile"]);
    expect(deps.uploadToSandbox).not.toHaveBeenCalled();
    expect(deps.restartGateway).not.toHaveBeenCalled();
  });

  it("skips (and cleans up) when the upload fails, without chmod or restart", () => {
    const deps = makeDeps({ uploadToSandbox: vi.fn(() => false) });
    const result = deliverMessagingSecretFiles("sbx", [GOOGLECHAT_TARGET], deps);

    expect(result.skipped).toEqual(["serviceAccountFile"]);
    // Only the mkdir exec ran; chmod must not run after a failed upload.
    expect(deps.execInSandbox).toHaveBeenCalledTimes(1);
    expect(deps.restartGateway).not.toHaveBeenCalled();
    expect(deps.removeTempFile).toHaveBeenCalledTimes(1);
  });

  it("restarts the gateway only once even for multiple files", () => {
    const second: MessagingSecretFileTarget = {
      ...GOOGLECHAT_TARGET,
      secretFileId: "second",
      target: "/sandbox/.openclaw/secrets/second.json",
    };
    const deps = makeDeps();
    deliverMessagingSecretFiles("sbx", [GOOGLECHAT_TARGET, second], deps);
    expect(deps.restartGateway).toHaveBeenCalledTimes(1);
  });
});
