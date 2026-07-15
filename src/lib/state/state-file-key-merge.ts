// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StateFileKeyAllowlistRestoreOwnership, StateFileUserKeyType } from "../agent/defs.js";

export { KEY_ALLOWLIST_MERGE_PYTHON } from "./key-allowlist-merge/python-script.js";

import { KEY_ALLOWLIST_MERGE_PYTHON } from "./key-allowlist-merge/python-script.js";

interface PythonUserKey {
  path: string[];
  type: StateFileUserKeyType;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  max_length?: number;
}

export interface KeyAllowlistMergeSpec {
  user_keys: PythonUserKey[];
  require_fresh_tables: string[][];
  require_fresh_headers: { match: "exact" | "prefix"; value: string }[];
}

export function stateFileKeyMergeSpec(
  ownership: StateFileKeyAllowlistRestoreOwnership,
): KeyAllowlistMergeSpec {
  return {
    user_keys: (ownership.userKeys ?? []).map((key) => {
      const spec: PythonUserKey = { path: key.key.split("."), type: key.type };
      if (key.type === "enum" && key.values) spec.values = key.values;
      if (key.type === "integer" || key.type === "number") {
        if (key.min !== undefined) spec.min = key.min;
        if (key.max !== undefined) spec.max = key.max;
      }
      if (key.type === "string" && key.maxLength !== undefined) spec.max_length = key.maxLength;
      return spec;
    }),
    require_fresh_tables: (ownership.requireFreshTables ?? []).map((table) => table.split(".")),
    require_fresh_headers: (ownership.requireFreshHeaders ?? []).map((header) => ({
      match: header.match,
      value: header.value,
    })),
  };
}
