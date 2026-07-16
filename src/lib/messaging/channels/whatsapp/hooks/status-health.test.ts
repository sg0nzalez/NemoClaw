// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport } from "../../channel-health";
import { createWhatsappStatusHealthHook } from "./status-health";
import type { WhatsappDiagnosticReport } from "./status-health-eval";

const BASE_INPUTS = {
  currentSandbox: "alpha",
  agent: "openclaw",
  probedAt: "2026-07-14T00:00:00.000Z",
  channelEnabledInRegistry: true,
  presetInRegistry: true,
  presetOnGateway: true,
};

function context(
  inputs: Record<string, unknown> = BASE_INPUTS,
  channelId = "whatsapp",
): MessagingHookContext {
  return {
    channelId,
    hookId: "whatsapp-status-health",
    phase: "status",
    inputs,
  } as unknown as MessagingHookContext;
}

type ExecResult = { status: number; stdout: string; stderr: string } | null;

function makeExec(result: ExecResult) {
  return vi.fn((_sandbox: string, _command: string, _timeout: number): ExecResult => result);
}

// The hook is synchronous; the handler type is a sync|Promise union, so narrow.
function reportOf(
  result: MessagingHookResult | Promise<MessagingHookResult>,
): WhatsappDiagnosticReport | undefined {
  const value = (result as MessagingHookResult).outputs?.channelHealth?.value as unknown as
    | { report?: WhatsappDiagnosticReport }
    | undefined;
  return value?.report;
}

function baseReportOf(
  result: MessagingHookResult | Promise<MessagingHookResult>,
): ChannelHealthReport | undefined {
  return reportOf(result);
}

function outputsOf(result: MessagingHookResult | Promise<MessagingHookResult>) {
  return (result as MessagingHookResult).outputs;
}

function makeProbeStdout(
  parts: {
    reachable?: boolean;
    dirs?: readonly { path: string; state: "MISSING" | "EMPTY" | "POPULATED" }[];
    heartbeat?: string | null;
    logLines?: readonly string[];
    procLines?: readonly string[];
    procDone?: boolean;
    gwAlive?: boolean;
    gwLastInbound?: string | null;
  } = {},
): string {
  const shellOk = parts.reachable === false ? [] : ["NEMOCLAW_WA_DIAG_OK"];
  const dirLines = (parts.dirs ?? []).map((dir) => `DIR ${dir.path} ${dir.state}`);
  const heartbeatBlock =
    parts.heartbeat == null
      ? []
      : ["NEMOCLAW_WA_HEARTBEAT_BEGIN", parts.heartbeat, "NEMOCLAW_WA_HEARTBEAT_END"];
  const logBlock = ["NEMOCLAW_WA_LOG_BEGIN", ...(parts.logLines ?? []), "NEMOCLAW_WA_LOG_END"];
  const gwAliveLine = parts.gwAlive ? ["NEMOCLAW_WA_GW_ALIVE"] : [];
  const gwInboundLine = parts.gwLastInbound
    ? [`NEMOCLAW_WA_GW_LAST_INBOUND ${parts.gwLastInbound}`]
    : [];
  const procBlock = parts.procLines ?? [];
  const procDoneLine = parts.procDone === false ? [] : ["NEMOCLAW_WA_PROC_DONE"];
  return [
    ...shellOk,
    ...dirLines,
    ...heartbeatBlock,
    ...logBlock,
    ...gwAliveLine,
    ...gwInboundLine,
    ...procBlock,
    ...procDoneLine,
  ].join("\n");
}

describe("whatsapp.statusHealth hook", () => {
  it("probes the state dirs and reports healthy when heartbeat shows recent inbound (#4386)", () => {
    const heartbeat = JSON.stringify({
      lastInboundAt: "2026-07-13T23:59:30.000Z",
      messagesHandled: 4,
      connectionState: "open",
    });
    const exec = makeExec({
      status: 0,
      stdout: makeProbeStdout({
        dirs: [{ path: "/sandbox/.openclaw/whatsapp", state: "POPULATED" }],
        heartbeat,
        procLines: ["PROC 1234 openclaw-whatsapp"],
      }),
      stderr: "",
    });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("healthy");
    // Extension type: the base guard should still classify this as a health
    // report even with the extra heartbeat field.
    expect(baseReportOf(result)?.channel).toBe("whatsapp");
  });

  it("probes the credentials/whatsapp path (OpenClaw 2026.6.10+) as populated evidence", () => {
    // Regression guard: OpenClaw 2026.6.10+ stores the paired Baileys session
    // under `credentials/whatsapp/<account>/creds.json`. When only that dir is
    // POPULATED (and the legacy `whatsapp/` path is MISSING) the diagnostic
    // must still see the sandbox as paired.
    const exec = makeExec({
      status: 0,
      stdout: makeProbeStdout({
        dirs: [
          { path: "/sandbox/.openclaw/whatsapp", state: "MISSING" },
          { path: "/sandbox/.openclaw/credentials/whatsapp", state: "POPULATED" },
        ],
        heartbeat: JSON.stringify({
          lastInboundAt: "2026-07-13T23:59:30.000Z",
          messagesHandled: 2,
          connectionState: "open",
        }),
        procLines: ["PROC 1234 openclaw-whatsapp"],
      }),
      stderr: "",
    });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const report = reportOf(result);
    expect(report?.verdict).toBe("healthy");
    const pairing = report?.signals.find((s) => s.label === "Pairing / session");
    expect(pairing?.severity).toBe("ok");
  });

  it("synthesizes a heartbeat from GW_ALIVE + GW_LAST_INBOUND when no heartbeat file exists", () => {
    // Part 2 (gateway-log liveness): the in-process bridge does not publish a
    // heartbeat file, but its provider-ready + inbound breadcrumbs are in the
    // gateway log. The hook must synthesize a heartbeat + alive bridge so the
    // "paired but no inbound observed" warning does not fire for a healthy
    // in-process bridge.
    const exec = makeExec({
      status: 0,
      stdout: makeProbeStdout({
        dirs: [{ path: "/sandbox/.openclaw/whatsapp", state: "POPULATED" }],
        heartbeat: null,
        gwAlive: true,
        gwLastInbound: "2026-07-13T23:59:30.000Z",
        procDone: true,
      }),
      stderr: "",
    });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const report = reportOf(result);
    expect(report?.verdict).toBe("healthy");
    expect(report?.heartbeat?.connectionState).toBe("open");
    expect(report?.heartbeat?.lastInboundAt).toBe("2026-07-13T23:59:30.000Z");
    const proc = report?.signals.find((s) => s.label === "Bridge process");
    expect(proc?.severity).toBe("ok");
  });

  it("emits a syntactically valid /bin/sh probe script", () => {
    // The probe is a multiline sh script (for/if/grep pipelines, marker
    // sequencing, and the gateway-log block). A shell syntax regression would
    // fail every real probe while mocked-stdout tests stay green; validate the
    // generated command with `sh -n`.
    const exec = makeExec({ status: 0, stdout: makeProbeStdout(), stderr: "" });
    createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const command = exec.mock.calls[0]?.[1] ?? "";
    const validation = spawnSync("sh", ["-n", "-c", command], { encoding: "utf-8" });
    expect(validation.status, validation.stderr || validation.stdout).toBe(0);
    // The probe must filter its own pgrep line out of the process results.
    expect(command).toMatch(/__nemoclaw_wa_self_pid/);
    expect(command).toMatch(/pgrep -fa/);
    // Part 2: gateway-log block scoped to whatsapp lines only. The bracket
    // form appears in the emitted shell as `\[whatsapp\]` (grep -E literal).
    expect(command).toMatch(/channels\/whatsapp/);
    expect(command).toMatch(/\\\[whatsapp\\\]/);
    expect(command).toMatch(/NEMOCLAW_WA_GW_ALIVE/);
    expect(command).toMatch(/NEMOCLAW_WA_GW_LAST_INBOUND/);
  });

  it("selects the hermes state-dir path when the agent is hermes", () => {
    const exec = makeExec({ status: 0, stdout: makeProbeStdout(), stderr: "" });
    createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(
      context({ ...BASE_INPUTS, agent: "hermes" }),
    );
    const command = exec.mock.calls[0]?.[1] ?? "";
    expect(command).toContain("/sandbox/.hermes/platforms/whatsapp/session");
    expect(command).not.toContain("/sandbox/.openclaw/");
  });

  it("selects the openclaw state-dir paths by default (both whatsapp and credentials/whatsapp)", () => {
    const exec = makeExec({ status: 0, stdout: makeProbeStdout(), stderr: "" });
    createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const command = exec.mock.calls[0]?.[1] ?? "";
    expect(command).toContain("/sandbox/.openclaw/whatsapp");
    expect(command).toContain("/sandbox/.openclaw/credentials/whatsapp");
  });

  it("reports probe_failed when the sandbox exec fails (null result)", () => {
    const exec = makeExec(null);
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("probe_failed");
  });

  it("reports probe_failed when stdout omits the shell-OK marker", () => {
    const exec = makeExec({ status: 0, stdout: "", stderr: "" });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("probe_failed");
  });

  it("reports probe_failed on a non-zero exec even when partial stdout carries healthy markers", () => {
    // A timed-out/killed exec can flush partial stdout that already contains
    // SHELL_OK (printed first) plus a populated dir and heartbeat. Without the
    // `exec.status === 0` guard this would read as `healthy` off partial data;
    // the clean-exit requirement keeps it classified as probe_failed.
    const exec = makeExec({
      status: 124,
      stdout: makeProbeStdout({
        dirs: [{ path: "/sandbox/.openclaw/whatsapp", state: "POPULATED" }],
        heartbeat: JSON.stringify({
          lastInboundAt: "2026-07-13T23:59:30.000Z",
          messagesHandled: 4,
          connectionState: "open",
        }),
        procLines: ["PROC 1234 openclaw-whatsapp"],
      }),
      stderr: "timed out",
    });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe("probe_failed");
  });

  it("derives config_gap / policy_gap from the host-fact inputs", () => {
    const exec = makeExec({
      status: 0,
      stdout: makeProbeStdout({
        dirs: [{ path: "/sandbox/.openclaw/whatsapp", state: "POPULATED" }],
      }),
      stderr: "",
    });
    const hook = createWhatsappStatusHealthHook({ executeSandboxCommand: exec });
    expect(
      reportOf(hook(context({ ...BASE_INPUTS, channelEnabledInRegistry: false })))?.verdict,
    ).toBe("config_gap");
    expect(reportOf(hook(context({ ...BASE_INPUTS, presetInRegistry: false })))?.verdict).toBe(
      "policy_gap",
    );
  });

  it("no-ops for a non-whatsapp channel or without an exec runner", () => {
    const exec = makeExec({ status: 0, stdout: makeProbeStdout(), stderr: "" });
    expect(
      outputsOf(
        createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(
          context(BASE_INPUTS, "slack"),
        ),
      ),
    ).toBeUndefined();
    expect(outputsOf(createWhatsappStatusHealthHook({})(context()))).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});
