// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { reconcileRegisteredExtraProviders } from "../src/lib/onboard/extra-provider-reconciliation.js";

type Argv = string[];
type RunResult = { status: number | null; stderr?: string; stdout?: string | Buffer };

function buildRunOpenshell(
  responses: Map<string, RunResult>,
  defaultResponse: RunResult = { status: 0 },
) {
  const calls: Argv[] = [];
  const fn = vi.fn((args: Argv, _opts?: Record<string, unknown>) => {
    calls.push(args);
    const key = args.join(" ");
    return responses.get(key) ?? defaultResponse;
  });
  return { runOpenshell: fn, calls };
}

describe("reconcileRegisteredExtraProviders", () => {
  it("returns the empty set without querying the gateway when nothing is recorded", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());
    const forget = vi.fn();

    const result = reconcileRegisteredExtraProviders({
      runOpenshell,
      listExtraProviders: () => [],
      forgetExtraProvider: forget,
    });

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
    expect(forget).not.toHaveBeenCalled();
  });

  it("keeps recorded providers that the gateway confirms via a scoped 'provider get'", () => {
    const responses = new Map([
      ["provider get -g nemoclaw tavily-search", { status: 0, stdout: "name: tavily-search\n" }],
    ]);
    const { runOpenshell, calls } = buildRunOpenshell(responses, { status: 1 });
    const forget = vi.fn();
    const warn = vi.fn();

    const result = reconcileRegisteredExtraProviders({
      runOpenshell,
      gatewayName: "nemoclaw",
      listExtraProviders: () => ["tavily-search"],
      forgetExtraProvider: forget,
      warn,
    });

    expect(result).toEqual(["tavily-search"]);
    expect(calls).toEqual([["provider", "get", "-g", "nemoclaw", "tavily-search"]]);
    expect(forget).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips, warns about, and forgets a recorded provider the gateway reports not found (#6501)", () => {
    const responses = new Map<string, RunResult>([
      [
        "provider get brave-search",
        { status: 1, stderr: "Error: provider 'brave-search' not found\n" },
      ],
      [
        "provider get tavily-search",
        { status: 1, stderr: 'rpc error: NotFound: provider "tavily-search"\n' },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const forget = vi.fn();
    const warn = vi.fn();

    const result = reconcileRegisteredExtraProviders({
      runOpenshell,
      listExtraProviders: () => ["brave-search", "tavily-search"],
      forgetExtraProvider: forget,
      warn,
    });

    expect(result).toEqual([]);
    expect(forget.mock.calls.map((c) => c[0])).toEqual(["brave-search", "tavily-search"]);
    const messages = warn.mock.calls.map((c) => c[0] as string);
    expect(messages[0]).toContain("'brave-search'");
    expect(messages[1]).toContain("'tavily-search'");
    expect(messages[1]).toContain("nemoclaw credentials add");
  });

  it("keeps the recorded set unchanged when the probe fails without a not-found diagnostic", () => {
    const responses = new Map<string, RunResult>([
      ["provider get tavily-search", { status: 1, stderr: "gateway not running" }],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const forget = vi.fn();
    const warn = vi.fn();

    const result = reconcileRegisteredExtraProviders({
      runOpenshell,
      listExtraProviders: () => ["tavily-search"],
      forgetExtraProvider: forget,
      warn,
    });

    expect(result).toEqual(["tavily-search"]);
    expect(forget).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("prunes on a Buffer not-found diagnostic while keeping confirmed bridge providers", () => {
    const responses = new Map<string, RunResult>([
      ["provider get my-slack-bridge", { status: 0 }],
      [
        "provider get tavily-search",
        { status: 1, stdout: Buffer.from("provider 'tavily-search' not found\n") },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);
    const forget = vi.fn();

    const result = reconcileRegisteredExtraProviders({
      runOpenshell,
      listExtraProviders: () => ["my-slack-bridge", "tavily-search"],
      forgetExtraProvider: forget,
    });

    expect(result).toEqual(["my-slack-bridge"]);
    expect(forget.mock.calls.map((c) => c[0])).toEqual(["tavily-search"]);
  });
});
