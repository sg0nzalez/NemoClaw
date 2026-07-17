// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type LiveProgress, type LiveProgressOptions, startLiveProgress } from "./live-progress.ts";

export type RebuildHermesProgressOptions = LiveProgressOptions;
export type RebuildHermesProgress = LiveProgress;

/**
 * Keep the long Hermes scenario visible without forwarding command output,
 * which may contain credentials. The timestamp-only output observer records
 * liveness while resource snapshots make hosted-runner loss diagnosable.
 */
export function startRebuildHermesProgress(
  initialPhase: string,
  options: RebuildHermesProgressOptions = {},
): RebuildHermesProgress {
  return startLiveProgress("rebuild-hermes", initialPhase, options);
}
