// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../src/lib/messaging/channels";
import { ManifestCompiler } from "../src/lib/messaging/compiler/manifest-compiler";
import type { SandboxMessagingPlan } from "../src/lib/messaging/manifest";

const require = createRequire(import.meta.url);

type ModuleProperty = string | number | boolean | Function | object | null | undefined;
type ModuleRecord = { [key: string]: ModuleProperty };

type HashCredentialInternals = {
  hashCredential: (value: string | null | undefined) => string | null;
};
type PlanCredentialRotationInternals = {
  detectMessagingCredentialRotationFromPlan: (
    sandboxName: string,
    plan: PlanLike | null | undefined,
    options?: { resolveCredential?: (envKey: string) => string | null | undefined },
  ) => { changed: boolean; changedProviders: string[] };
};
type PlanLike = {
  readonly disabledChannels: readonly string[];
  readonly channels: ReadonlyArray<{
    readonly channelId: string;
    readonly active: boolean;
    readonly disabled: boolean;
  }>;
  readonly credentialBindings: ReadonlyArray<{
    readonly channelId: string;
    readonly providerName: string;
    readonly providerEnvKey: string;
  }>;
};

type PlanBindingFixture = {
  readonly channelId: string;
  readonly credentialId?: string;
  readonly sourceInput?: string;
  readonly providerName: string;
  readonly providerEnvKey: string;
  readonly placeholder?: string;
  readonly credentialHash?: string;
};

const ROTATION_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "WECHAT_BOT_TOKEN",
] as const;
type RotationEnvKey = (typeof ROTATION_ENV_KEYS)[number];

const STORED_ROTATION_TOKENS: Record<RotationEnvKey, string> = {
  TELEGRAM_BOT_TOKEN: "old-telegram-token",
  DISCORD_BOT_TOKEN: "old-discord-token",
  SLACK_BOT_TOKEN: "xoxb-old-slack-bot-token",
  SLACK_APP_TOKEN: "xapp-old-slack-app-token",
  WECHAT_BOT_TOKEN: "old-wechat-token",
};

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function compileCredentialRotationPlan(sandboxName: string): Promise<SandboxMessagingPlan> {
  return withEnv(
    {
      TELEGRAM_BOT_TOKEN: undefined,
      DISCORD_BOT_TOKEN: undefined,
      SLACK_BOT_TOKEN: undefined,
      SLACK_APP_TOKEN: undefined,
      WECHAT_BOT_TOKEN: undefined,
      WECHAT_ACCOUNT_ID: "wechat-account-id",
    },
    () =>
      new ManifestCompiler(createBuiltInChannelManifestRegistry()).compile({
        sandboxName,
        agent: "openclaw",
        workflow: "rebuild",
        isInteractive: false,
        configuredChannels: ["telegram", "discord", "slack", "wechat"],
        credentialAvailability: {
          TELEGRAM_BOT_TOKEN: true,
          DISCORD_BOT_TOKEN: true,
          SLACK_BOT_TOKEN: true,
          SLACK_APP_TOKEN: true,
          WECHAT_BOT_TOKEN: true,
        },
      }),
  );
}

function isRecord(value: object | null): value is ModuleRecord {
  return value !== null && !Array.isArray(value);
}

function isRegistryModule(value: object | null): value is typeof import("../dist/lib/state/registry.js") {
  return isRecord(value) && typeof value.getSandbox === "function";
}

function loadHashCredentialInternals(): HashCredentialInternals {
  const loaded = require("../dist/lib/security/credential-hash.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isRecord(record) || typeof record.hashCredential !== "function") {
    throw new Error("Expected credential-hash module to expose hashCredential");
  }
  return record as HashCredentialInternals;
}

function loadRegistryModule(): typeof import("../dist/lib/state/registry.js") {
  const loaded = require("../dist/lib/state/registry.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (!isRegistryModule(record)) {
    throw new Error("Expected registry module to expose getSandbox");
  }
  return record;
}

function loadPlanCredentialRotationInternals(): PlanCredentialRotationInternals {
  const loaded = require("../dist/lib/onboard/messaging-credentials.js");
  const record = typeof loaded === "object" && loaded !== null ? loaded : null;
  if (
    !isRecord(record) ||
    typeof record.detectMessagingCredentialRotationFromPlan !== "function"
  ) {
    throw new Error("Expected messaging-credentials internals to expose plan rotation helper");
  }
  return record as PlanCredentialRotationInternals;
}

describe("credential rotation detection", () => {
  let hashCredential: HashCredentialInternals["hashCredential"];
  let detectMessagingCredentialRotationFromPlan: PlanCredentialRotationInternals["detectMessagingCredentialRotationFromPlan"];
  let registry: typeof import("../dist/lib/state/registry.js");

  beforeEach(() => {
    // Fresh imports to avoid cross-test contamination
    ({ hashCredential } = loadHashCredentialInternals());
    ({ detectMessagingCredentialRotationFromPlan } = loadPlanCredentialRotationInternals());
    registry = loadRegistryModule();
  });

  function hashCredentialOrThrow(value: string): string {
    const hash = hashCredential(value);
    expect(hash).not.toBeNull();
    if (!hash) {
      throw new Error(`Expected hashCredential(${JSON.stringify(value)}) to return a hash`);
    }
    return hash;
  }

  describe("hashCredential", () => {
    it("returns null for falsy values", () => {
      expect(hashCredential(null)).toBeNull();
      expect(hashCredential("")).toBeNull();
      expect(hashCredential(undefined)).toBeNull();
    });

    it("returns null for whitespace-only values", () => {
      expect(hashCredential("   ")).toBeNull();
      expect(hashCredential("\r\n\t")).toBeNull();
    });

    it("returns a 64-char hex SHA-256 hash for valid input", () => {
      const hash = hashCredential("my-secret-token");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces consistent hashes for the same input", () => {
      const a = hashCredential("token-abc");
      const b = hashCredential("token-abc");
      expect(a).toBe(b);
    });

    it("produces different hashes for different inputs", () => {
      const a = hashCredential("token-A");
      const b = hashCredential("token-B");
      expect(a).not.toBe(b);
    });

    it("trims whitespace before hashing", () => {
      const a = hashCredential("  token  ");
      const b = hashCredential("token");
      expect(a).toBe(b);
    });
  });

  function makePlanEntry(name: string, bindings: readonly PlanBindingFixture[]) {
    return {
      name,
      messaging: {
        schemaVersion: 1 as const,
        plan: {
          schemaVersion: 1 as const,
          sandboxName: name,
          agent: "openclaw" as const,
          workflow: "onboard" as const,
          channels: [],
          disabledChannels: [],
          credentialBindings: bindings.map((b) => ({
            channelId: b.channelId,
            credentialId: b.credentialId ?? `${b.channelId}Credential`,
            sourceInput: b.sourceInput ?? "botToken",
            providerName: b.providerName,
            providerEnvKey: b.providerEnvKey,
            placeholder: b.placeholder ?? `openshell:resolve:env:${b.providerEnvKey}`,
            credentialAvailable: true,
            ...(b.credentialHash ? { credentialHash: b.credentialHash } : {}),
          })),
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          stateUpdates: [],
          healthChecks: [],
        },
      },
    };
  }

  function makeCurrentPlan(
    bindings: Array<{ channelId: string; providerName: string; providerEnvKey: string }>,
    options: { disabledChannels?: string[] } = {},
  ): PlanLike {
    return {
      disabledChannels: options.disabledChannels ?? [],
      channels: [...new Set(bindings.map((binding) => binding.channelId))].map((channelId) => ({
        channelId,
        active: true,
        disabled: false,
      })),
      credentialBindings: bindings.map((binding) => ({
        channelId: binding.channelId,
        providerName: binding.providerName,
        providerEnvKey: binding.providerEnvKey,
      })),
    };
  }

  function makeStoredPlanEntryFromPlan(
    sandboxName: string,
    plan: SandboxMessagingPlan,
    storedTokens: Readonly<Partial<Record<string, string>>>,
  ) {
    return {
      name: sandboxName,
      messaging: {
        schemaVersion: 1 as const,
        plan: {
          ...plan,
          credentialBindings: plan.credentialBindings.map((binding) => {
            const token = storedTokens[binding.providerEnvKey];
            if (!token) {
              throw new Error(`Missing stored token fixture for ${binding.providerEnvKey}`);
            }
            return {
              ...binding,
              credentialHash: hashCredentialOrThrow(token),
            };
          }),
        },
      },
    };
  }

  describe("detectMessagingCredentialRotationFromPlan", () => {
    it("returns changed: false when no plan is stored (pre-plan sandbox)", () => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "test-sandbox" });

      const result = detectMessagingCredentialRotationFromPlan(
        "test-sandbox",
        makeCurrentPlan([
          {
            channelId: "telegram",
            providerName: "test-sandbox-telegram-bridge",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
          },
        ]),
        { resolveCredential: () => "new-token" },
      );

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("returns changed providers from the current manifest plan when hashes differ", () => {
      const oldHash = hashCredentialOrThrow("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          {
            channelId: "telegram",
            providerName: "test-sandbox-telegram-bridge",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: oldHash,
          },
        ]),
      );

      const result = detectMessagingCredentialRotationFromPlan(
        "test-sandbox",
        makeCurrentPlan([
          {
            channelId: "telegram",
            providerName: "test-sandbox-telegram-bridge",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
          },
        ]),
        { resolveCredential: () => "new-token" },
      );

      expect(result.changed).toBe(true);
      expect(result.changedProviders).toEqual(["test-sandbox-telegram-bridge"]);
      vi.restoreAllMocks();
    });

    it.each([
      ["DISCORD_BOT_TOKEN"],
      ["SLACK_BOT_TOKEN"],
      ["SLACK_APP_TOKEN"],
      ["WECHAT_BOT_TOKEN"],
    ] as const)(
      "reports only the manifest provider for rotated %s when other bindings are unchanged",
      async (rotatedEnvKey) => {
        const sandboxName = "test-sandbox";
        const currentPlan = await compileCredentialRotationPlan(sandboxName);
        const storedEntry = makeStoredPlanEntryFromPlan(
          sandboxName,
          currentPlan,
          STORED_ROTATION_TOKENS,
        );
        vi.spyOn(registry, "getSandbox").mockReturnValue(storedEntry);

        const targetProvider = currentPlan.credentialBindings.find(
          (binding) => binding.providerEnvKey === rotatedEnvKey,
        )?.providerName;
        if (!targetProvider) {
          throw new Error(`Expected manifest plan to include ${rotatedEnvKey}`);
        }

        const currentTokens = {
          ...STORED_ROTATION_TOKENS,
          [rotatedEnvKey]: `${STORED_ROTATION_TOKENS[rotatedEnvKey]}-rotated`,
        };
        const result = detectMessagingCredentialRotationFromPlan(
          sandboxName,
          currentPlan,
          { resolveCredential: (envKey) => currentTokens[envKey] ?? null },
        );

        expect(result.changed).toBe(true);
        expect(result.changedProviders).toEqual([targetProvider]);
        for (const providerName of currentPlan.credentialBindings
          .filter((binding) => binding.providerEnvKey !== rotatedEnvKey)
          .map((binding) => binding.providerName)) {
          expect(result.changedProviders).not.toContain(providerName);
        }
        vi.restoreAllMocks();
      },
    );

    it("skips comparison when the current credential is unavailable", () => {
      const oldHash = hashCredentialOrThrow("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          {
            channelId: "telegram",
            providerName: "test-sandbox-telegram-bridge",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: oldHash,
          },
        ]),
      );

      const result = detectMessagingCredentialRotationFromPlan(
        "test-sandbox",
        makeCurrentPlan([
          {
            channelId: "telegram",
            providerName: "test-sandbox-telegram-bridge",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
          },
        ]),
        { resolveCredential: () => null },
      );

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });

    it("ignores disabled channels", () => {
      const oldHash = hashCredentialOrThrow("old-token");
      vi.spyOn(registry, "getSandbox").mockReturnValue(
        makePlanEntry("test-sandbox", [
          {
            channelId: "telegram",
            providerName: "test-sandbox-telegram-bridge",
            providerEnvKey: "TELEGRAM_BOT_TOKEN",
            credentialHash: oldHash,
          },
        ]),
      );

      const result = detectMessagingCredentialRotationFromPlan(
        "test-sandbox",
        makeCurrentPlan(
          [
            {
              channelId: "telegram",
              providerName: "test-sandbox-telegram-bridge",
              providerEnvKey: "TELEGRAM_BOT_TOKEN",
            },
          ],
          { disabledChannels: ["telegram"] },
        ),
        { resolveCredential: () => "new-token" },
      );

      expect(result.changed).toBe(false);
      expect(result.changedProviders).toEqual([]);
      vi.restoreAllMocks();
    });
  });
});
