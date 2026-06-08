// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../channels";
import { MessagingWorkflowPlanner } from "../compiler";
import type { MessagingAgentId, SandboxMessagingPlan } from "../manifest";
import { validateBuiltInSandboxMessagingPlan } from "./plan-validation";

async function buildPlan(
  options: {
    readonly agent?: MessagingAgentId;
    readonly configuredChannels?: readonly string[];
    readonly disabledChannels?: readonly string[];
  } = {},
): Promise<SandboxMessagingPlan> {
  return new MessagingWorkflowPlanner(createBuiltInChannelManifestRegistry()).buildPlan({
    sandboxName: "demo",
    agent: options.agent ?? "openclaw",
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: options.configuredChannels ?? ["telegram"],
    disabledChannels: options.disabledChannels ?? [],
    credentialAvailability: {
      TELEGRAM_BOT_TOKEN: true,
      DISCORD_BOT_TOKEN: true,
    },
    credentialHashes: {
      TELEGRAM_BOT_TOKEN: "telegram-hash",
      DISCORD_BOT_TOKEN: "discord-hash",
    },
  });
}

function validate(
  plan: SandboxMessagingPlan,
  options: {
    readonly agent?: MessagingAgentId;
    readonly configuredChannels?: readonly string[];
    readonly disabledChannels?: readonly string[];
  } = {},
) {
  return validateBuiltInSandboxMessagingPlan(plan, {
    sandboxName: "demo",
    agent: options.agent ?? "openclaw",
    configuredChannels: options.configuredChannels ?? ["telegram"],
    disabledChannels: options.disabledChannels ?? [],
  });
}

describe("validateBuiltInSandboxMessagingPlan", () => {
  it("accepts a manifest-derived plan for the selected sandbox and agent", async () => {
    expect(validate(await buildPlan())).toEqual({ ok: true });
  });

  it("rejects a plan for a different selected agent", async () => {
    const result = validate(await buildPlan(), { agent: "hermes" });

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/agent/);
  });

  it("rejects credential bindings that do not match manifest provider fields", async () => {
    const plan = await buildPlan();
    const tampered = {
      ...plan,
      credentialBindings: plan.credentialBindings.map((binding) => ({
        ...binding,
        providerName: "demo-attacker",
        providerEnvKey: "OPENAI_API_KEY",
      })),
    };

    const result = validate(tampered);

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/providerName|providerEnvKey/);
  });

  it("rejects policy presets that are not declared by the channel manifest", async () => {
    const plan = await buildPlan();
    const tampered = {
      ...plan,
      networkPolicy: {
        presets: [...plan.networkPolicy.presets, "host-network"],
        entries: [
          ...plan.networkPolicy.entries,
          {
            channelId: "telegram",
            presetName: "host-network",
            policyKeys: ["host-network"],
            source: "manifest" as const,
          },
        ],
      },
    };

    const result = validate(tampered);

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/network policy/);
  });

  it("rejects active channels that were not selected for sandbox creation", async () => {
    const plan = await buildPlan({ configuredChannels: ["telegram", "discord"] });

    const result = validate(plan, { configuredChannels: ["telegram"] });

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/discord/);
  });

  it("accepts a configured channel that is stopped in the registry", async () => {
    const plan = await buildPlan({
      configuredChannels: ["telegram"],
      disabledChannels: ["telegram"],
    });

    const result = validate(plan, {
      configuredChannels: ["telegram"],
      disabledChannels: ["telegram"],
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects a plan that omits a registry-disabled channel", async () => {
    const plan = await buildPlan();

    const result = validate(plan, { disabledChannels: ["telegram"] });

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/disabled channel/);
  });
});
