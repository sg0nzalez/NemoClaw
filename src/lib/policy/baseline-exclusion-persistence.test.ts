// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBaselineExclusion: vi.fn(),
  getSandbox: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  addBaselineExclusion: mocks.addBaselineExclusion,
  getSandbox: mocks.getSandbox,
}));

import * as openshellResolveModule from "../adapters/openshell/resolve";
import { digestBaselineEntry, getBaselineEntry } from "./baseline-exclusion";
import { excludeBaselineEntry } from "./index";

const LIVE_POLICY = `version: 1
network_policies:
  nous_research:
    endpoints:
      - host: nousresearch.com
        port: 443
`;
const LIVE_ENTRY = getBaselineEntry(LIVE_POLICY, "nous_research");
const LIVE_DIGEST = digestBaselineEntry(LIVE_ENTRY!);

describe("excludeBaselineEntry persistence boundary (#7178)", () => {
  beforeEach(() => {
    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runCapture.mockReturnValue(LIVE_POLICY);
    mocks.run.mockReturnValue({ status: 0 });
    mocks.getSandbox.mockReturnValue({ name: "alpha", agentVersion: "1.2.3" });
    mocks.addBaselineExclusion.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("reports failure when the live narrowing cannot be recorded durably", () => {
    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.addBaselineExclusion).toHaveBeenCalledWith("alpha", {
      key: "nous_research",
      digest: LIVE_DIGEST,
      appliedAgentVersion: "1.2.3",
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("could not be recorded"));
  });

  it("refuses to remove a live entry that changed after the operator preview", () => {
    mocks.runCapture.mockReturnValue(
      LIVE_POLICY.replace("nousresearch.com", "changed.example.test"),
    );

    expect(excludeBaselineEntry("alpha", "nous_research", "stale-digest", { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.addBaselineExclusion).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("changed after preview"));
  });
});
