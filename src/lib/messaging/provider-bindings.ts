// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "./channels";
import type { ChannelManifestRegistry, SandboxMessagingPlan } from "./manifest";

export function getProviderNamesFromMessagingPlan(
  plan: SandboxMessagingPlan | null | undefined,
  channelId: string,
): string[] {
  if (!plan) return [];
  return [
    ...new Set(
      plan.credentialBindings
        .filter((binding) => binding.channelId === channelId)
        .map((binding) => binding.providerName),
    ),
  ];
}

/**
 * Compatibility helper for pre-plan registry rows. Remove once all supported
 * registry entries are migrated to `messaging.plan.credentialBindings`.
 */
export function getManifestProviderNamesForChannel(
  sandboxName: string,
  channelId: string,
  registry: ChannelManifestRegistry = createBuiltInChannelManifestRegistry(),
): string[] | null {
  const manifest = registry.get(channelId);
  if (!manifest) return null;
  return [
    ...new Set(
      manifest.credentials.map((credential) =>
        credential.providerName.replaceAll("{sandboxName}", sandboxName),
      ),
    ),
  ];
}
