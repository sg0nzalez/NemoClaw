// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { type McpLifecycleLockOptions, withMcpLifecycleLock } from "../state/mcp-lifecycle-lock";
import { resolveHome, STATE_DIR_NAME } from "../state/state-root";

const DUAL_STATION_VLLM_LIFECYCLE_LOCK = "dual-station-vllm:host-global";

/**
 * Serialize the host-managed dual-Station service across gateway instances.
 *
 * This deliberately anchors the lease at the default ~/.nemoclaw root instead
 * of a gateway-specific state root: every local NemoClaw process controls the
 * same two fixed Docker container names on the same pair of daemons.
 */
export function withDualStationVllmLifecycleLock<T>(
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  const stateDir = options.stateDir ?? path.join(resolveHome(), STATE_DIR_NAME, "state");
  return withMcpLifecycleLock(DUAL_STATION_VLLM_LIFECYCLE_LOCK, operation, {
    ...options,
    stateDir,
  });
}
