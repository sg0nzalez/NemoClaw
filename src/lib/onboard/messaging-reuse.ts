// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getManifestProviderNamesForChannel,
  getProviderNamesFromMessagingPlan,
  type SandboxMessagingPlan,
} from "../messaging";

type MessagingChannel = { name: string; envKey?: string };
type SandboxEntry =
  | {
      messagingChannels?: string[] | null;
      messaging?: { plan?: SandboxMessagingPlan | null } | null;
    }
  | null
  | undefined;

function getKnownMessagingChannels(
  channels: string[] | null | undefined,
  messagingChannels: readonly MessagingChannel[],
): string[] {
  if (!Array.isArray(channels)) return [];
  const known = new Set(messagingChannels.map((channel) => channel.name));
  return [...new Set(channels.filter((channel) => known.has(channel)))];
}

export function getNonInteractiveStoredMessagingChannels(
  resume: boolean,
  sessionChannels: string[] | null | undefined,
  sandboxName: string | null,
  messagingChannels: readonly MessagingChannel[],
  hasMessagingToken: (envKey: string) => boolean,
  getSandbox: (sandboxName: string) => SandboxEntry,
  getDisabledChannels: (sandboxName: string) => string[],
  providerExists: (providerName: string) => boolean,
  nonInteractive: boolean,
): string[] | null {
  if (!nonInteractive) return null;
  if (resume && Array.isArray(sessionChannels)) {
    const knownSessionChannels = getKnownMessagingChannels(sessionChannels, messagingChannels);
    return knownSessionChannels;
  }
  if (
    resume ||
    !sandboxName ||
    messagingChannels.some((channel) => Boolean(channel.envKey && hasMessagingToken(channel.envKey)))
  ) {
    return null;
  }

  const sandboxEntry = getSandbox(sandboxName);
  const configuredChannels = getKnownMessagingChannels(
    sandboxEntry?.messagingChannels,
    messagingChannels,
  );
  const disabledChannels = new Set(getDisabledChannels(sandboxName));
  const reusableChannels = configuredChannels.filter((channel) => {
    if (disabledChannels.has(channel)) return false;
    const providers = getReusableProviderNames(sandboxName, sandboxEntry, channel);
    return providers.length > 0 && providers.every((provider) => providerExists(provider));
  });
  return reusableChannels.length > 0 ? reusableChannels : null;
}

function getReusableProviderNames(
  sandboxName: string,
  entry: SandboxEntry,
  channel: string,
): string[] {
  const planned = getProviderNamesFromMessagingPlan(entry?.messaging?.plan, channel);
  if (planned.length > 0) return planned;
  return getManifestProviderNamesForChannel(sandboxName, channel) ?? [];
}
