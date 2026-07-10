// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { createRecovery, type RecoveryAuthority } from "./provider-inference-recovery";

function completedSession() {
  const session = createSession({
    sessionId: "session-current",
    sandboxName: "dc-after",
  });
  session.steps.sandbox.status = "complete";
  return session;
}

describe("provider inference recovery authorization", () => {
  it("revokes registered recovery when the registry row disappears under the lock", () => {
    const getSandboxRecoveryAuthority = vi
      .fn<() => RecoveryAuthority>()
      .mockReturnValueOnce("authorized")
      .mockReturnValueOnce("missing");
    const session = completedSession();
    const recovery = createRecovery(false, "dc-after", session, {
      getSandboxRecoveryAuthority,
    });

    expect(recovery.shouldRecover()).toBe(true);
    const options = recovery.setupOptions(true, "dc-after", session.sessionId);

    expect(options.isRecordedProviderRecoveryAuthorized?.()).toBe(false);
  });

  it("preserves missing-row recovery only for the captured matching completed session", () => {
    const getSandboxRecoveryAuthority = vi.fn<() => RecoveryAuthority>(() => "missing");
    const session = completedSession();
    const recovery = createRecovery(false, "dc-after", session, {
      getSandboxRecoveryAuthority,
    });

    expect(recovery.shouldRecover()).toBe(true);
    const options = recovery.setupOptions(true, "dc-after", session.sessionId);

    expect(options.isRecordedProviderRecoveryAuthorized?.()).toBe(true);
  });

  it("does not transfer missing-row session authority to another sandbox name", () => {
    const getSandboxRecoveryAuthority = vi.fn<() => RecoveryAuthority>(() => "missing");
    const session = completedSession();
    const recovery = createRecovery(false, "dc-after", session, {
      getSandboxRecoveryAuthority,
    });

    expect(recovery.shouldRecover()).toBe(true);
    const options = recovery.setupOptions(true, "dc-renamed", session.sessionId);

    expect(options.isRecordedProviderRecoveryAuthorized?.()).toBe(false);
  });
});
