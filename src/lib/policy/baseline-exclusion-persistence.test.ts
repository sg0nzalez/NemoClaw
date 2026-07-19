// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBaselineExclusion: vi.fn(),
  getBaselineExclusions: vi.fn(),
  getSandbox: vi.fn(),
  removeBaselineExclusion: vi.fn(),
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
  getBaselineExclusions: mocks.getBaselineExclusions,
  getSandbox: mocks.getSandbox,
  removeBaselineExclusion: mocks.removeBaselineExclusion,
}));

import * as openshellResolveModule from "../adapters/openshell/resolve";
import { digestBaselineEntry, getBaselineEntry } from "./baseline-exclusion";
import { excludeBaselineEntry, restoreBaselineEntry } from "./index";

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
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      agentVersion: "1.2.3",
    });
    mocks.getBaselineExclusions.mockReturnValue([]);
    mocks.addBaselineExclusion.mockReturnValue(false);
    mocks.removeBaselineExclusion.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("does not narrow live egress when the exclusion cannot be recorded durably", () => {
    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.addBaselineExclusion).toHaveBeenCalledWith("alpha", {
      key: "nous_research",
      digest: LIVE_DIGEST,
      appliedAgentVersion: "1.2.3",
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no live policy changes"));
  });

  it("removes a new durable exclusion when live narrowing fails", () => {
    mocks.addBaselineExclusion.mockReturnValue(true);
    mocks.run.mockReturnValue({ status: 19 });

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.addBaselineExclusion).toHaveBeenCalledOnce();
    expect(mocks.removeBaselineExclusion).toHaveBeenCalledWith("alpha", "nous_research");
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

describe("restoreBaselineEntry persistence boundary (#7178)", () => {
  const RECORDED = {
    key: "nous_research",
    digest: LIVE_DIGEST,
    acknowledgedAt: "2026-07-19T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runCapture.mockReturnValue("version: 1\nnetwork_policies: {}\n");
    mocks.run.mockReturnValue({ status: 0 });
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      agentVersion: "1.2.3",
    });
    mocks.getBaselineExclusions.mockReturnValue([RECORDED]);
    mocks.removeBaselineExclusion.mockReturnValue(true);
    mocks.addBaselineExclusion.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("does not widen live egress when the exclusion record cannot be removed", () => {
    mocks.removeBaselineExclusion.mockReturnValue(false);

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no live policy changes"));
  });

  it("restores the durable exclusion when live policy restoration fails", () => {
    mocks.run.mockReturnValue({ status: 19 });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(mocks.removeBaselineExclusion).toHaveBeenCalledWith("alpha", "nous_research");
    expect(mocks.addBaselineExclusion).toHaveBeenCalledWith("alpha", RECORDED);
  });
});
