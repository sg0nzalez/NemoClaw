// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../../state/registry";

function validRecordedValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function providerModelConfigChanged(
  existing: SandboxEntry | null,
  provider: string,
  model: string,
): boolean {
  if (!existing) return false;
  return (
    validRecordedValue(existing.provider) !== provider ||
    validRecordedValue(existing.model) !== model
  );
}
