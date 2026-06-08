// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BUILT_IN_CHANNEL_MANIFESTS } from "../channels";

// Map channelId to providerEnvKey values declared in built-in manifests.
// The comparison layer uses this as the primary key set so a missing hash for
// one required credential conservatively reports unknown-token.
export const CHANNEL_CREDENTIAL_ENV_KEYS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    BUILT_IN_CHANNEL_MANIFESTS.map((m) => [m.id, m.credentials.map((c) => c.providerEnvKey)]),
  );

export const PROVIDER_SUFFIXES: Record<string, string[]> = Object.fromEntries(
  BUILT_IN_CHANNEL_MANIFESTS.flatMap((m) => {
    const suffixes = m.credentials.map((c) => c.providerName.replace("{sandboxName}", ""));
    if (suffixes.length === 0) return [];
    return [[m.id, suffixes]];
  }),
);
