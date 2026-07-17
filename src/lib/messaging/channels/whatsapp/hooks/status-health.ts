// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `whatsapp.statusHealth` — a `phase: "status"` hook that probes the live
 * WhatsApp bridge state from inside the sandbox and emits a
 * `messaging-channel-health` status output. Run by the generic channels-status
 * command via the status-hook runner, so no whatsapp-specific code lives in
 * the generic status orchestrator.
 *
 * The probe reads OpenClaw's authoritative live status JSON:
 *
 *   openclaw channels status --channel whatsapp --json --timeout <ms>
 *
 * That JSON already reflects the live `linked`/`running`/`connected` /
 * `healthState` state kept by the in-process bridge, so the probe never
 * needs to scrape gateway-log breadcrumbs, list a credentials directory,
 * or grep for a bridge process — all three signals were misleading in
 * different real cases:
 *
 *   - Append-only `starting provider` breadcrumbs in `/tmp/gateway.log`
 *     survive across restarts, so a stopped bridge would still read
 *     "provider ready" (false-positive healthy).
 *   - A non-empty `credentials/whatsapp` dir does not imply a valid paired
 *     session — half-written state or credentials from a prior tenant
 *     read as "populated" without actually pairing.
 *   - The bridge runs inside the OpenClaw gateway process, so `pgrep`
 *     could not enumerate it and the probe would report "unpaired" for
 *     a working bridge.
 *
 * For Hermes (secondary), which has no `openclaw` CLI in the sandbox, the
 * probe checks for an authoritative session credentials file (Baileys
 * `creds.json`) under `<hermes>/platforms/whatsapp/session` instead of a
 * loose directory-listing check.
 *
 * Redaction contract: this probe never reads, stores, logs, or emits the
 * self.e164 / self.jid / self.lid values or the raw `lastError` string
 * from the OpenClaw JSON — those can carry phone numbers. Only booleans,
 * state-string enums, and epoch timestamps make it into the report.
 */

import { shellQuote as quotePath } from "../../../../core/shell-quote";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelStatusHealthHookOptions,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";
import {
  evaluateWhatsappDiagnostics,
  type WhatsappHeartbeat,
  type WhatsappProbeInput,
} from "./status-health-eval";

export const WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID = "whatsapp.statusHealth";

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the diagnostic. WhatsApp's in-process bridge can go unresponsive when
// the Noise WebSocket is stuck; a fast hard cap keeps channels status from
// inheriting that hang.
const DEFAULT_TIMEOUT_MS = 8_000;
// The Hermes credentials probe emits one of these two literal markers so the
// host parser can tell "session file present" from "session file missing" or
// "probe failed". Absent stdout is treated as probe failure.
const HERMES_SESSION_PRESENT = "NEMOCLAW_WA_HERMES_SESSION_PRESENT";
const HERMES_SESSION_ABSENT = "NEMOCLAW_WA_HERMES_SESSION_ABSENT";
// Baileys writes the paired session under `<sessionDir>/creds.json`. Hermes'
// WhatsApp adapter follows that convention, so a present `creds.json` is the
// authoritative pairing signal — a non-empty session dir alone is not.
const HERMES_SESSION_CREDS_FILE = "/sandbox/.hermes/platforms/whatsapp/session/creds.json";

/** WhatsApp uses the generic channel-health hook options unchanged. */
export type WhatsappStatusHealthHookOptions = ChannelStatusHealthHookOptions;

export function createWhatsappStatusHealthHook(
  options: WhatsappStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "whatsapp") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    // Without a sandbox target or an exec runner there is nothing to probe
    // (e.g. the top-level status runner does not thread an exec runner into
    // this hook).
    if (!execute || !sandboxName) return {};

    const agent = normalizeString(context.inputs?.agent) ?? "openclaw";
    // Only openclaw and hermes have a defined WhatsApp bridge shape. The
    // manifest already gates this hook to those agents; guard explicitly so a
    // future agent added to the manifest without a probe here degrades to the
    // basic report instead of silently running the openclaw CLI against it.
    if (agent !== "openclaw" && agent !== "hermes") return {};
    const stateDirs = resolveWhatsappStateDirs(agent);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const probe =
      agent === "hermes"
        ? runHermesSessionProbe(execute, sandboxName, timeoutMs)
        : runOpenclawStatusProbe(execute, sandboxName, timeoutMs);

    const input: WhatsappProbeInput = {
      agent,
      stateDirs,
      stateDirPopulated: probe.stateDirPopulated,
      heartbeat: probe.heartbeat,
      heartbeatParseError: null,
      bridgeProcessAlive: probe.bridgeProcessAlive,
      recentLogSignals: probe.recentLogSignals,
      probeReachable: probe.probeReachable,
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      presetInRegistry: Boolean(context.inputs?.presetInRegistry),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
    };
    const report = evaluateWhatsappDiagnostics(input);
    return {
      outputs: {
        channelHealth: {
          kind: "status",
          value: {
            type: MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
            report,
          } as unknown as MessagingSerializableValue,
        },
      },
    };
  };
}

export function createWhatsappStatusHealthHookRegistration(
  options: WhatsappStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createWhatsappStatusHealthHook(options),
  };
}

/**
 * The two known WhatsApp bridge state layouts, keyed by agent name. The
 * OpenClaw entries are informational — the openclaw probe no longer inspects
 * these directories (it reads the CLI's live JSON instead) but the paths are
 * still surfaced in the "Pairing / session" signal detail so the operator
 * knows where the session material lives if they need to intervene. The
 * Hermes entry is the actual credentials-file parent the hermes probe stats.
 */
export function resolveWhatsappStateDirs(agent: string): string[] {
  if (agent === "hermes") {
    return ["/sandbox/.hermes/platforms/whatsapp/session"];
  }
  // OpenClaw 2026.6.10+ writes the paired Baileys session under
  // `credentials/whatsapp/<account>/creds.json`, not `<configDir>/whatsapp`.
  return ["/sandbox/.openclaw/whatsapp", "/sandbox/.openclaw/credentials/whatsapp"];
}

type OpenclawWhatsappState = {
  readonly configured?: unknown;
  readonly statusState?: unknown;
  readonly linked?: unknown;
  readonly running?: unknown;
  readonly connected?: unknown;
  readonly healthState?: unknown;
  readonly lastInboundAt?: unknown;
  readonly lastStopAt?: unknown;
  readonly lastDisconnect?: unknown;
  readonly reconnectAttempts?: unknown;
};

type ProbeResult = {
  readonly probeReachable: boolean;
  readonly stateDirPopulated: boolean | null;
  readonly bridgeProcessAlive: boolean | null;
  readonly heartbeat: WhatsappHeartbeat | null;
  readonly recentLogSignals: readonly string[];
};

const PROBE_UNREACHABLE: ProbeResult = {
  probeReachable: false,
  stateDirPopulated: null,
  bridgeProcessAlive: null,
  heartbeat: null,
  recentLogSignals: [],
};

/**
 * OpenClaw branch. Runs `openclaw channels status --channel whatsapp --json`
 * inside the sandbox and translates the authoritative response into the
 * evaluator's probe-input shape. The CLI shells out to the gateway, which
 * reflects the in-process bridge's current state, so this replaces the old
 * log-scraping + pgrep + dir-listing signals with a single trusted source.
 */
function runOpenclawStatusProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
): ProbeResult {
  const command = `openclaw channels status --channel whatsapp --json --timeout ${timeoutMs}`;
  const exec = execute(sandboxName, command, timeoutMs);
  // A non-zero exec (timeout/kill/unhealthy sandbox) can still carry partial
  // stdout; require a clean exit before trusting the probe. Otherwise a
  // stalled openclaw invocation could yield unparseable JSON that reads as a
  // fabricated verdict instead of classifying as probe_failed.
  if (!exec || exec.status !== 0) return PROBE_UNREACHABLE;
  const json = parseOpenclawJson(String(exec.stdout ?? ""));
  if (!json) return PROBE_UNREACHABLE;

  const channels = readObject(json.channels);
  const wa = channels ? readObject(channels.whatsapp) : null;
  if (!wa) {
    // No `channels.whatsapp`. Two distinct causes the CLI reports, told apart
    // by the `error` string: the gateway is up but whatsapp is not configured
    // on it (`error: "unknown channel: …"`), or the gateway is unreachable.
    // Either way leave the runtime fields null so the evaluator lands on
    // "unknown"; only the diagnostic wording differs.
    return {
      probeReachable: true,
      stateDirPopulated: null,
      bridgeProcessAlive: null,
      heartbeat: null,
      recentLogSignals: [describeMissingWaChannel(json)],
    };
  }
  return mapOpenclawWaState(wa);
}

function mapOpenclawWaState(wa: OpenclawWhatsappState): ProbeResult {
  const linked = wa.linked === true;
  const running = wa.running === true;
  const connected = wa.connected === true;
  const healthState = readStringValue(wa.healthState);
  const heartbeat: WhatsappHeartbeat | null = running
    ? {
        connectionState: openclawConnectionState(connected, healthState),
        lastInboundAt: epochMsToIso(wa.lastInboundAt),
        // The OpenClaw JSON does not expose a cumulative inbound counter —
        // the evaluator treats `null` here as "not reported" rather than
        // "zero", which is the accurate reading.
        messagesHandled: null,
        // Never copy the bridge's free-text `lastError` — it can carry phone
        // numbers and message bodies. If the evaluator needs error signal it
        // reads healthState/connectionState instead.
        noteCategory: null,
      }
    : null;
  return {
    probeReachable: true,
    // linked is the authoritative pairing bit; the credentials-directory
    // check that used to sit here mistook half-written state as "populated".
    stateDirPopulated: linked,
    // running is the authoritative liveness bit; the pgrep check that used
    // to sit here could not see the in-process bridge, and the gateway-log
    // breadcrumbs are append-only so they survived a stopped bridge.
    bridgeProcessAlive: running,
    heartbeat,
    recentLogSignals: summarizeOpenclawLive(healthState, wa.reconnectAttempts),
  };
}

function openclawConnectionState(connected: boolean, healthState: string | null): string {
  if (connected) return "open";
  return healthState === "starting" || healthState === "stale" ? "connecting" : "close";
}

// Never emit raw error text or self.* PII. Only healthState (an enum) and
// reconnectAttempts (a non-negative integer) are surfaced, and only when they
// carry non-healthy signal.
function summarizeOpenclawLive(
  healthState: string | null,
  reconnectAttemptsRaw: unknown,
): readonly string[] {
  const parts: string[] = [];
  if (healthState && healthState !== "healthy") {
    parts.push(`healthState=${healthState}`);
  }
  const reconnectAttempts =
    typeof reconnectAttemptsRaw === "number" && Number.isFinite(reconnectAttemptsRaw)
      ? reconnectAttemptsRaw
      : null;
  if (reconnectAttempts !== null && reconnectAttempts > 0) {
    parts.push(`reconnectAttempts=${reconnectAttempts}`);
  }
  return parts.length > 0 ? [parts.join("; ")] : [];
}

/**
 * Hermes branch. Hermes' sandbox has no `openclaw` CLI, so the probe checks
 * for the actual Baileys session artifact (`creds.json`) under the platform's
 * session directory. A missing file is authoritative "not paired"; a present
 * file is authoritative "session material exists". Bridge liveness/heartbeat
 * are not available from a session file alone, so those stay null and the
 * evaluator lands on "idle" for a paired-but-unprobed hermes runtime — that
 * is honest for a secondary agent whose runtime we cannot inspect further.
 */
function runHermesSessionProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
): ProbeResult {
  const command = [
    `set +e`,
    `if [ -f ${quotePath(HERMES_SESSION_CREDS_FILE)} ]; then`,
    `  printf '%s\\n' ${quotePath(HERMES_SESSION_PRESENT)}`,
    `else`,
    `  printf '%s\\n' ${quotePath(HERMES_SESSION_ABSENT)}`,
    `fi`,
  ].join("\n");
  const exec = execute(sandboxName, command, timeoutMs);
  if (!exec || exec.status !== 0) return PROBE_UNREACHABLE;
  const lines = String(exec.stdout ?? "").split(/\r?\n/);
  const present = lines.includes(HERMES_SESSION_PRESENT);
  const absent = lines.includes(HERMES_SESSION_ABSENT);
  if (!present && !absent) return PROBE_UNREACHABLE;
  return {
    probeReachable: true,
    stateDirPopulated: present,
    bridgeProcessAlive: null,
    heartbeat: null,
    recentLogSignals: [],
  };
}

function parseOpenclawJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const attempts: string[] = [trimmed];
  // Fall back to substring parsing if the CLI ever emits a leading warning
  // line on stdout — stdout should be clean JSON but be defensive.
  const braceIdx = trimmed.indexOf("{");
  if (braceIdx > 0) attempts.push(trimmed.slice(braceIdx));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObjectRecord(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// The CLI reports a missing `channels.whatsapp` for two different reasons;
// an `error: "unknown channel: …"` means the gateway is up but whatsapp is
// not configured on it, otherwise treat the gateway as unreachable. Emit a
// fixed diagnostic string — never the raw `error`, which can carry PII.
function describeMissingWaChannel(json: Record<string, unknown>): string {
  const error = readStringValue(json.error);
  return error !== null && /unknown channel/i.test(error)
    ? "whatsapp is not configured on the gateway — live health unavailable"
    : "gateway not reachable — live WhatsApp health unavailable";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The largest timestamp the ECMAScript Date type can represent; beyond it
// `new Date(v).toISOString()` throws RangeError. A garbage `lastInboundAt`
// from the gateway JSON must degrade to null, not crash the status command.
const MAX_ECMASCRIPT_DATE_MS = 8_640_000_000_000_000;

function epochMsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > MAX_ECMASCRIPT_DATE_MS) return null;
  return new Date(value).toISOString();
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTristate(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}
