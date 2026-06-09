// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScenarioEnvironment } from "./types.ts";

export function resolveExecutableOnboardingProfile(
  environment: Pick<ScenarioEnvironment, "runtime" | "onboarding">,
): string {
  if (environment.runtime === "docker-missing" && !environment.onboarding.endsWith("-no-docker")) {
    return `${environment.onboarding}-no-docker`;
  }
  return environment.onboarding;
}
