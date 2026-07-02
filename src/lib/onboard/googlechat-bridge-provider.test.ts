// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  configureGooglechatBridgeRefresh,
  ensureGooglechatBridgeProfile,
  GOOGLECHAT_BRIDGE_CREDENTIAL_KEY,
  GOOGLECHAT_BRIDGE_PENDING_VALUE,
  GOOGLECHAT_BRIDGE_PROFILE_ID,
  GOOGLECHAT_SERVICE_ACCOUNT_ENV,
  maybeGooglechatBridgeTokenDef,
  resolveGooglechatServiceAccount,
} from "./googlechat-bridge-provider";

const SA_JSON = JSON.stringify({
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n",
});
const normalizeCredentialValue = (v: unknown) => String(v ?? "").trim();
const redact = (s: string) => s;
const noLog = vi.fn();

const BRIDGE_DEF = {
  name: "sbx-googlechat-bridge",
  providerType: GOOGLECHAT_BRIDGE_PROFILE_ID,
  token: GOOGLECHAT_BRIDGE_PENDING_VALUE,
};

function tokenDefInput(
  overrides: Partial<Parameters<typeof maybeGooglechatBridgeTokenDef>[0]> = {},
) {
  return {
    sandboxName: "sbx",
    getCredential: () => null,
    enabledChannels: ["googlechat"],
    disabledChannelNames: new Set<string>(),
    ...overrides,
  };
}

describe("resolveGooglechatServiceAccount", () => {
  it("prefers the credential store over the injected env", () => {
    const value = resolveGooglechatServiceAccount({
      getCredential: (k) => (k === GOOGLECHAT_SERVICE_ACCOUNT_ENV ? "from-store" : null),
      env: { [GOOGLECHAT_SERVICE_ACCOUNT_ENV]: "from-env" },
      normalizeCredentialValue,
    });
    expect(value).toBe("from-store");
  });

  it("falls back to the injected env when the store is empty", () => {
    const value = resolveGooglechatServiceAccount({
      getCredential: () => null,
      env: { [GOOGLECHAT_SERVICE_ACCOUNT_ENV]: "  from-env  " },
      normalizeCredentialValue,
    });
    expect(value).toBe("from-env");
  });

  it("returns null when neither store nor env has the value", () => {
    expect(
      resolveGooglechatServiceAccount({
        getCredential: () => null,
        env: {},
        normalizeCredentialValue,
      }),
    ).toBeNull();
  });
});

describe("maybeGooglechatBridgeTokenDef", () => {
  it("returns null when Google Chat is disabled", () => {
    expect(
      maybeGooglechatBridgeTokenDef(
        tokenDefInput({
          getCredential: () => SA_JSON,
          disabledChannelNames: new Set(["googlechat"]),
        }),
      ),
    ).toBeNull();
  });

  it("returns null when Google Chat is not in the enabled channels", () => {
    expect(
      maybeGooglechatBridgeTokenDef(
        tokenDefInput({ getCredential: () => SA_JSON, enabledChannels: ["slack"] }),
      ),
    ).toBeNull();
  });

  it("returns null when no service account is available", () => {
    expect(maybeGooglechatBridgeTokenDef(tokenDefInput())).toBeNull();
  });

  it("emits the bridge token def when the service account is in the store", () => {
    const def = maybeGooglechatBridgeTokenDef(tokenDefInput({ getCredential: () => SA_JSON }));
    expect(def).toEqual({
      name: "sbx-googlechat-bridge",
      envKey: GOOGLECHAT_BRIDGE_CREDENTIAL_KEY,
      token: GOOGLECHAT_BRIDGE_PENDING_VALUE,
      providerType: GOOGLECHAT_BRIDGE_PROFILE_ID,
    });
  });

  it("emits the bridge token def from an env-only service account (resolution parity)", () => {
    const def = maybeGooglechatBridgeTokenDef(
      tokenDefInput({
        getCredential: () => null,
        env: { [GOOGLECHAT_SERVICE_ACCOUNT_ENV]: SA_JSON },
        normalizeCredentialValue,
      }),
    );
    expect(def?.providerType).toBe(GOOGLECHAT_BRIDGE_PROFILE_ID);
    expect(def?.envKey).toBe(GOOGLECHAT_BRIDGE_CREDENTIAL_KEY);
  });
});

describe("configureGooglechatBridgeRefresh", () => {
  it("is a no-op success when there is no bridge token def", () => {
    const runOpenshell = vi.fn();
    const result = configureGooglechatBridgeRefresh([], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when the service account is unavailable", () => {
    const result = configureGooglechatBridgeRefresh([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => null,
      log: noLog,
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when the service account JSON cannot be parsed", () => {
    const result = configureGooglechatBridgeRefresh([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => "not json",
      log: noLog,
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when client_email or private_key is missing", () => {
    const result = configureGooglechatBridgeRefresh([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => JSON.stringify({ client_email: "x@y" }),
      log: noLog,
    });
    expect(result.ok).toBe(false);
  });

  it("configures refresh and returns ok when runOpenshell succeeds", () => {
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({ status: 0 }));
    const result = configureGooglechatBridgeRefresh([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(1);
    const args = runOpenshell.mock.calls[0][0];
    expect(args.slice(0, 3)).toEqual(["provider", "refresh", "configure"]);
    expect(args).toContain(GOOGLECHAT_BRIDGE_CREDENTIAL_KEY);
    expect(args).toContain("google-service-account-jwt");
    expect(args).toContain("client_email=bot@p.iam.gserviceaccount.com");
    expect(args).toContain("private_key");
    expect(args).toContain("sbx-googlechat-bridge");
  });

  it("fails closed when runOpenshell exits nonzero", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "gateway rejected the material" }));
    const result = configureGooglechatBridgeRefresh([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("resolves the service account from the injected env too (parity)", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const result = configureGooglechatBridgeRefresh([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => null,
      env: { [GOOGLECHAT_SERVICE_ACCOUNT_ENV]: SA_JSON },
      normalizeCredentialValue,
      log: noLog,
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(1);
  });
});

describe("ensureGooglechatBridgeProfile", () => {
  const baseDeps = () => ({
    root: "/repo",
    redact,
    log: noLog,
    exit: vi.fn(() => undefined as never),
  });

  it("does nothing when there is no bridge token def", () => {
    const runOpenshell = vi.fn();
    ensureGooglechatBridgeProfile([], { ...baseDeps(), runOpenshell });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("imports the profile and does not exit on success", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const exit = vi.fn(() => undefined as never);
    ensureGooglechatBridgeProfile([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(runOpenshell).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("tolerates an already-registered profile without exiting", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "profile already exists" }));
    const exit = vi.fn(() => undefined as never);
    ensureGooglechatBridgeProfile([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits when profile import fails for another reason", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "connection refused" }));
    const exit = vi.fn(() => undefined as never);
    ensureGooglechatBridgeProfile([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(exit).toHaveBeenCalled();
  });
});
