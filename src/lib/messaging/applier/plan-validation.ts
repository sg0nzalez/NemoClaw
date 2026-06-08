// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "../channels";
import type {
  ChannelManifest,
  ChannelPolicyPresetReference,
  ChannelPolicyPresetSpec,
  MessagingAgentId,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingPlan,
} from "../manifest";

export interface BuiltInMessagingPlanValidationContext {
  readonly sandboxName: string;
  readonly agent: MessagingAgentId;
  readonly configuredChannels?: readonly string[] | null;
  readonly disabledChannels?: readonly string[] | null;
}

export interface MessagingPlanValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function validateBuiltInSandboxMessagingPlan(
  plan: SandboxMessagingPlan | null | undefined,
  context: BuiltInMessagingPlanValidationContext,
): MessagingPlanValidationResult {
  if (!plan) return invalid("plan is missing");
  if (plan.sandboxName !== context.sandboxName) {
    return invalid("sandboxName does not match requested sandbox");
  }
  if (plan.agent !== context.agent) return invalid("agent does not match selected agent");

  const registry = createBuiltInChannelManifestRegistry();
  const supported = new Set(
    registry.listAvailable({ agent: context.agent }).map((manifest) => manifest.id),
  );
  const channelResult = validateChannels(plan, context, registry, supported);
  if (!channelResult.ok) return channelResult;

  const channelIds = new Set(plan.channels.map((channel) => channel.channelId));
  const credentialResult = validateCredentialBindings(plan, registry, channelIds);
  if (!credentialResult.ok) return credentialResult;

  const policyResult = validateNetworkPolicy(plan, registry, channelIds, context.agent);
  if (!policyResult.ok) return policyResult;

  return validatePlanEntryChannelIds(plan, channelIds);
}

function validateChannels(
  plan: SandboxMessagingPlan,
  context: BuiltInMessagingPlanValidationContext,
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  supported: ReadonlySet<string>,
): MessagingPlanValidationResult {
  const seen = new Set<string>();
  const disabled = new Set(plan.disabledChannels);

  for (const channelId of plan.disabledChannels) {
    if (typeof channelId !== "string") return invalid("disabled channel id is not a string");
  }

  for (const channel of plan.channels) {
    if (!isRecord(channel)) return invalid("channel entry is not an object");
    if (typeof channel.channelId !== "string") return invalid("channel id is not a string");
    if (seen.has(channel.channelId)) return invalid(`duplicate channel '${channel.channelId}'`);
    seen.add(channel.channelId);
    if (!supported.has(channel.channelId)) {
      return invalid(`channel '${channel.channelId}' is not supported for ${context.agent}`);
    }
    const manifest = registry.get(channel.channelId);
    if (!manifest) return invalid(`unknown channel '${channel.channelId}'`);
    if (channel.displayName !== manifest.displayName) {
      return invalid(`channel '${channel.channelId}' display name does not match manifest`);
    }
    if (channel.authMode !== manifest.auth.mode) {
      return invalid(`channel '${channel.channelId}' auth mode does not match manifest`);
    }
    if (channel.active && (channel.disabled || disabled.has(channel.channelId))) {
      return invalid(`channel '${channel.channelId}' is active while disabled`);
    }
    if (channel.active && !hasRequiredInputsAvailable(manifest, channel)) {
      return invalid(`channel '${channel.channelId}' is active without required inputs`);
    }
    if (disabled.has(channel.channelId) && (!channel.disabled || channel.active)) {
      return invalid(`disabled channel '${channel.channelId}' is not marked inactive`);
    }
    const inputResult = validateChannelInputs(manifest, channel);
    if (!inputResult.ok) return inputResult;
  }

  for (const channelId of disabled) {
    if (!seen.has(channelId)) return invalid(`disabled channel '${channelId}' is not configured`);
  }

  const configured = context.configuredChannels
    ? new Set(context.configuredChannels.filter((channelId) => supported.has(channelId)))
    : null;
  if (configured) {
    for (const channelId of configured) {
      if (!seen.has(channelId)) return invalid(`configured channel '${channelId}' is missing`);
    }
    for (const channel of plan.channels) {
      if (channel.active && !configured.has(channel.channelId)) {
        return invalid(`active channel '${channel.channelId}' was not selected`);
      }
    }
  }

  const requiredDisabled = context.disabledChannels
    ? context.disabledChannels.filter((channelId) => supported.has(channelId))
    : [];
  for (const channelId of requiredDisabled) {
    if (!disabled.has(channelId)) {
      return invalid(`disabled channel '${channelId}' is missing from plan`);
    }
  }

  return valid();
}

function validateChannelInputs(
  manifest: ChannelManifest,
  channel: SandboxMessagingChannelPlan,
): MessagingPlanValidationResult {
  if (!Array.isArray(channel.inputs)) {
    return invalid(`channel '${channel.channelId}' inputs are not an array`);
  }
  const expected = new Map(manifest.inputs.map((input) => [input.id, input]));
  const seen = new Set<string>();
  for (const input of channel.inputs) {
    if (!isRecord(input)) return invalid(`channel '${channel.channelId}' input is not an object`);
    if (input.channelId !== channel.channelId) {
      return invalid(`channel '${channel.channelId}' input channel id mismatch`);
    }
    if (typeof input.inputId !== "string") {
      return invalid(`channel '${channel.channelId}' input id is not a string`);
    }
    if (seen.has(input.inputId)) {
      return invalid(`channel '${channel.channelId}' has duplicate input '${input.inputId}'`);
    }
    seen.add(input.inputId);
    const spec = expected.get(input.inputId);
    if (!spec) {
      return invalid(`channel '${channel.channelId}' has unknown input '${input.inputId}'`);
    }
    if (input.kind !== spec.kind || input.required !== spec.required) {
      return invalid(
        `channel '${channel.channelId}' input '${input.inputId}' does not match manifest`,
      );
    }
    if (input.sourceEnv !== spec.envKey) {
      return invalid(
        `channel '${channel.channelId}' input '${input.inputId}' env does not match manifest`,
      );
    }
    if (
      input.credentialAvailable !== undefined &&
      typeof input.credentialAvailable !== "boolean"
    ) {
      return invalid(
        `channel '${channel.channelId}' input '${input.inputId}' availability is invalid`,
      );
    }
  }
  for (const inputId of expected.keys()) {
    if (!seen.has(inputId)) {
      return invalid(`channel '${channel.channelId}' is missing input '${inputId}'`);
    }
  }
  return valid();
}

function validateCredentialBindings(
  plan: SandboxMessagingPlan,
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  channelIds: ReadonlySet<string>,
): MessagingPlanValidationResult {
  const expected = new Map<string, ExpectedCredentialBinding>();
  for (const channelId of channelIds) {
    const manifest = registry.get(channelId);
    if (!manifest) continue;
    for (const credential of manifest.credentials) {
      expected.set(`${channelId}:${credential.id}`, {
        channelId,
        credentialId: credential.id,
        sourceInput: credential.sourceInput,
        providerName: credential.providerName.replaceAll("{sandboxName}", plan.sandboxName),
        providerEnvKey: credential.providerEnvKey,
        placeholder: credential.placeholder,
      });
    }
  }

  const seen = new Set<string>();
  for (const binding of plan.credentialBindings) {
    if (!isRecord(binding)) return invalid("credential binding is not an object");
    const key = `${String(binding.channelId)}:${String(binding.credentialId)}`;
    if (seen.has(key)) return invalid(`duplicate credential binding '${key}'`);
    seen.add(key);
    const expectedBinding = expected.get(key);
    if (!expectedBinding) return invalid(`unexpected credential binding '${key}'`);
    const mismatch = credentialBindingMismatch(binding, expectedBinding);
    if (mismatch) return invalid(mismatch);
    if (typeof binding.credentialAvailable !== "boolean") {
      return invalid(`credential binding '${key}' availability is invalid`);
    }
    if (binding.credentialHash !== undefined && typeof binding.credentialHash !== "string") {
      return invalid(`credential binding '${key}' hash is invalid`);
    }
  }

  for (const key of expected.keys()) {
    if (!seen.has(key)) return invalid(`missing credential binding '${key}'`);
  }

  for (const channel of plan.channels) {
    if (!channel.active) continue;
    const activeBindings = plan.credentialBindings.filter(
      (binding) => binding.channelId === channel.channelId,
    );
    if (activeBindings.some((binding) => binding.credentialAvailable !== true)) {
      return invalid(`active channel '${channel.channelId}' has unavailable credentials`);
    }
  }

  return valid();
}

interface ExpectedCredentialBinding {
  readonly channelId: string;
  readonly credentialId: string;
  readonly sourceInput: string;
  readonly providerName: string;
  readonly providerEnvKey: string;
  readonly placeholder: string;
}

function credentialBindingMismatch(
  binding: Record<string, unknown>,
  expected: ExpectedCredentialBinding,
): string | null {
  for (const key of [
    "channelId",
    "credentialId",
    "sourceInput",
    "providerName",
    "providerEnvKey",
    "placeholder",
  ] as const) {
    if (binding[key] !== expected[key]) {
      return (
        `credential binding '${expected.channelId}:${expected.credentialId}' ` +
        `${key} does not match manifest`
      );
    }
  }
  return null;
}

function validateNetworkPolicy(
  plan: SandboxMessagingPlan,
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  channelIds: ReadonlySet<string>,
  agent: MessagingAgentId,
): MessagingPlanValidationResult {
  if (!isRecord(plan.networkPolicy) || !Array.isArray(plan.networkPolicy.entries)) {
    return invalid("network policy is invalid");
  }
  const expectedEntries = [...channelIds].flatMap((channelId) => {
    const manifest = registry.get(channelId);
    return manifest ? expectedPolicyEntries(manifest, agent) : [];
  });
  const expected = new Map(expectedEntries.map((entry) => [policyEntryKey(entry), entry]));
  const seen = new Set<string>();

  for (const entry of plan.networkPolicy.entries) {
    if (!isRecord(entry)) return invalid("network policy entry is not an object");
    if (
      typeof entry.channelId !== "string" ||
      typeof entry.presetName !== "string" ||
      (entry.source !== "agent-alias" && entry.source !== "manifest")
    ) {
      return invalid("network policy entry has invalid identity fields");
    }
    const key = policyEntryKey({
      channelId: entry.channelId,
      presetName: entry.presetName,
      source: entry.source,
    });
    if (seen.has(key)) return invalid(`duplicate network policy entry '${key}'`);
    seen.add(key);
    const expectedEntry = expected.get(key);
    if (!expectedEntry) return invalid(`unexpected network policy entry '${key}'`);
    if (!sameStringArray(entry.policyKeys, expectedEntry.policyKeys)) {
      return invalid(`network policy entry '${key}' policy keys do not match manifest`);
    }
  }

  for (const key of expected.keys()) {
    if (!seen.has(key)) return invalid(`missing network policy entry '${key}'`);
  }

  const expectedPresets = uniqueStrings(expectedEntries.map((entry) => entry.presetName));
  if (!sameStringArray(plan.networkPolicy.presets, expectedPresets)) {
    return invalid("network policy presets do not match manifest entries");
  }

  return valid();
}

function expectedPolicyEntries(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
): SandboxMessagingNetworkPolicyEntryPlan[] {
  return (manifest.policyPresets ?? []).map((preset) => {
    const policy = normalizePolicyPreset(preset);
    const agentPolicyKeys = policy.agentPolicyKeys?.[agent];
    if (agentPolicyKeys) {
      return {
        channelId: manifest.id,
        presetName: policy.name,
        policyKeys: [...agentPolicyKeys],
        source: "agent-alias",
      };
    }
    return {
      channelId: manifest.id,
      presetName: policy.name,
      policyKeys: [...(policy.policyKeys ?? [policy.name])],
      source: "manifest",
    };
  });
}

function normalizePolicyPreset(preset: ChannelPolicyPresetReference): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

function validatePlanEntryChannelIds(
  plan: SandboxMessagingPlan,
  channelIds: ReadonlySet<string>,
): MessagingPlanValidationResult {
  const groups: Array<[string, readonly { readonly channelId: string }[]]> = [
    ["agentRender", plan.agentRender],
    ["buildSteps", plan.buildSteps],
    ["stateUpdates", plan.stateUpdates],
    ["healthChecks", plan.healthChecks],
  ];
  for (const [label, entries] of groups) {
    for (const entry of entries) {
      if (!isRecord(entry)) return invalid(`${label} entry is not an object`);
      if (typeof entry.channelId !== "string" || !channelIds.has(entry.channelId)) {
        return invalid(`${label} entry references unknown channel`);
      }
    }
  }
  return valid();
}

function hasRequiredInputsAvailable(
  manifest: ChannelManifest,
  channel: SandboxMessagingChannelPlan,
): boolean {
  const byId = new Map(channel.inputs.map((input) => [input.inputId, input]));
  return manifest.inputs.every((input) => {
    if (!input.required) return true;
    const resolved = byId.get(input.id);
    if (!resolved) return false;
    if (resolved.kind === "secret") return resolved.credentialAvailable === true;
    if (resolved.value === undefined) return false;
    return typeof resolved.value === "string" ? resolved.value.trim().length > 0 : true;
  });
}

function policyEntryKey(
  entry: Pick<
    SandboxMessagingNetworkPolicyEntryPlan,
    "channelId" | "presetName" | "source"
  >,
): string {
  return `${entry.channelId}:${entry.presetName}:${entry.source}`;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid(): MessagingPlanValidationResult {
  return { ok: true };
}

function invalid(reason: string): MessagingPlanValidationResult {
  return { ok: false, reason };
}
