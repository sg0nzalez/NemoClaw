// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifySandboxCreateFailure } from "./validation";

describe("classifySandboxCreateFailure Landlock failures", () => {
  it.each([
    "Landlock unavailable in hard_requirement mode: not implemented (kernel lacks CONFIG_SECURITY_LANDLOCK)",
    'Landlock path unavailable in hard_requirement mode: /app (path does not exist): failed to open "/app": No such file or directory (os error 2)',
    "Landlock filesystem sandbox unavailable (hard_requirement, will fail): ABI v1 below required ABI v2\nFailed to prepare sandbox: partially incompatible access-rights: Refer",
    "Landlock filesystem sandbox unavailable (hard_requirement, will fail): ABI v1 below required ABI v2\nFailed to prepare sandbox: failed to create a ruleset: Operation not permitted (os error 1)",
    "Landlock filesystem sandbox unavailable (hard_requirement, will fail): ABI v1 below required ABI v2\nFailed to prepare sandbox: failed to add a rule: Invalid argument (os error 22)",
    "Landlock filesystem sandbox unavailable (hard_requirement, will fail): ABI v1 below required ABI v2\nFailed to prepare sandbox: failed to set no_new_privs: Operation not permitted (os error 1)",
    "Landlock filesystem sandbox unavailable (hard_requirement, will fail): ABI v1 below required ABI v2\nFailed to prepare sandbox: failed to restrict the calling thread: Operation not permitted (os error 1)",
  ])("detects a hard-required Landlock enforcement failure: %s", (message) => {
    const result = classifySandboxCreateFailure(`Created sandbox: test\n${message}`);

    expect(result.kind).toBe("landlock_enforcement_failed");
    expect(result.uploadedToGateway).toBe(true);
  });

  it("does not infer an uploaded sandbox from a pre-create hard Landlock error", () => {
    const result = classifySandboxCreateFailure(
      "Landlock unavailable in hard_requirement mode: not enabled in the active LSM set",
    );

    expect(result.kind).toBe("landlock_enforcement_failed");
    expect(result.uploadedToGateway).toBe(false);
  });

  it.each([
    "Landlock filesystem sandbox unavailable: partially incompatible access-rights: Refer",
    "Landlock restrict_self failed (best_effort): failed to restrict the calling thread: EPERM",
  ])("does not classify a best-effort Landlock warning as fatal: %s", (message) => {
    expect(classifySandboxCreateFailure(message).kind).toBe("unknown");
  });

  it.each([
    "Failed to set no_new_privs: Operation not permitted (os error 1)",
    "failed to set no_new_privs: Operation not permitted (os error 1)",
    "failed to restrict the calling thread: Operation not permitted (os error 1)",
    "failed to create a ruleset: unrelated build tool failure",
    "failed to add a rule: unrelated policy engine failure",
    "Failed to prepare supervisor identity isolation: failed to create a ruleset",
    "Failed to prepare sandbox: failed to create a ruleset: unrelated build tool error",
    "Failed to prepare sandbox: failed to set no_new_privs: Operation not permitted",
  ])("does not classify a non-Landlock sandbox-create error as Landlock: %s", (message) => {
    expect(classifySandboxCreateFailure(`Created sandbox: test\n${message}`).kind).toBe(
      "sandbox_create_incomplete",
    );
  });
});
