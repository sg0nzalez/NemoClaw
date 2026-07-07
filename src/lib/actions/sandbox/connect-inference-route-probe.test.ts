// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildSandboxInferenceRouteProbeArgs,
  classifyInferenceRouteFailureLabel,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";

const INFERENCE_ROUTE_PROBE_SCRIPT = [
  "HTTP_CODE=$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || HTTP_CODE=000",
  'case "$HTTP_CODE" in [1-4][0-9][0-9]) printf \'OK %s\' "$HTTP_CODE" ;; *) printf \'BROKEN %s\' "$HTTP_CODE" ;; esac',
].join("; ");

describe("sandbox connect inference route probe argv", () => {
  it("uses the dcode login-shell proxy contract without inherited proxy variables (#6191)", () => {
    const args = buildSandboxInferenceRouteProbeArgs("deep-code", {
      name: "langchain-deepagents-code",
    });

    expect(args).toEqual([
      "sandbox",
      "exec",
      "--name",
      "deep-code",
      "--",
      "env",
      "-u",
      "HTTP_PROXY",
      "-u",
      "HTTPS_PROXY",
      "-u",
      "http_proxy",
      "-u",
      "https_proxy",
      "-u",
      "NO_PROXY",
      "-u",
      "no_proxy",
      "-u",
      "ALL_PROXY",
      "-u",
      "all_proxy",
      "HOME=/sandbox",
      "bash",
      "-lc",
      INFERENCE_ROUTE_PROBE_SCRIPT,
    ]);
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
  });

  it.each([
    null,
    { name: "openclaw" },
    { name: "hermes" },
  ])("preserves the plain sh probe for non-dcode agents (%j)", (agent) => {
    expect(buildSandboxInferenceRouteProbeArgs("alpha", agent)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "sh",
      "-c",
      INFERENCE_ROUTE_PROBE_SCRIPT,
    ]);
  });

  it("discards the response without a persistent sandbox temp file (#6192)", () => {
    const args = buildSandboxInferenceRouteProbeArgs("alpha", { name: "openclaw" });
    const script = args.at(-1) ?? "";

    expect(script).toContain("-o /dev/null");
    expect(script).not.toContain("/tmp/");
    expect(script).not.toContain("head -c");
  });
});

describe("sandbox inference route probe result", () => {
  it.each([
    [0, "unreachable"],
    [499, "unreachable"],
    [500, "unhealthy"],
    [599, "unhealthy"],
    [600, "unreachable"],
  ] as const)("classifies HTTP %i route failures as %s (#6192)", (httpStatus, expected) => {
    expect(classifyInferenceRouteFailureLabel(httpStatus)).toBe(expected);
  });

  it.each([
    "100",
    "200",
    "401",
    "499",
  ])("accepts HTTP %s as a reachable route (#6192)", (httpStatus) => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 0, output: `OK ${httpStatus}` }),
    ).toMatchObject({ healthy: true, broken: false, httpStatus: Number(httpStatus) });
  });

  it.each([
    "000",
    "500",
    "503",
    "599",
    "600",
  ])("rejects HTTP %s as a broken route (#6192)", (httpStatus) => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 0, output: `BROKEN ${httpStatus}` }),
    ).toMatchObject({ healthy: false, broken: true, httpStatus: Number(httpStatus) });
  });

  it("does not classify an unavailable probe as healthy or broken (#6192)", () => {
    expect(
      parseSandboxInferenceRouteProbeResult({ status: 1, output: "transport unavailable" }),
    ).toMatchObject({ healthy: false, broken: false, httpStatus: 0 });
  });

  it("fails closed when malformed output claims an unhealthy status is OK (#6192)", () => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output: "OK 503" })).toMatchObject({
      healthy: false,
      broken: true,
      httpStatus: 503,
    });
  });

  it.each([
    "[stdout] OK 200",
    "stdout: OK 401",
  ])("accepts framed healthy output from OpenShell (%s) (#6192)", (output) => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output })).toMatchObject({
      healthy: true,
      broken: false,
    });
  });

  it.each([
    "[stdout] BROKEN 503 service unavailable",
    "stdout: BROKEN 000",
  ])("accepts framed broken output from OpenShell (%s) (#6192)", (output) => {
    expect(parseSandboxInferenceRouteProbeResult({ status: 0, output })).toMatchObject({
      healthy: false,
      broken: true,
    });
  });
});
