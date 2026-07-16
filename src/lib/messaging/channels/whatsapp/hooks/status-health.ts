// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `whatsapp.statusHealth` — a `phase: "status"` hook that probes the live
 * WhatsApp bridge state from inside the sandbox and emits a
 * `messaging-channel-health` status output. Run by the generic channels-status
 * command via the status-hook runner, so no whatsapp-specific code lives in
 * the generic status orchestrator.
 *
 * WhatsApp has two supported bridge shapes:
 *
 *   1. OpenClaw: a Baileys session under either `<configDir>/whatsapp` or the
 *      newer `<configDir>/credentials/whatsapp` layout (OpenClaw 2026.6.10+
 *      stores the paired session there). The bridge may either run inside the
 *      gateway process (in which case the pgrep probe cannot enumerate it,
 *      and gateway-log breadcrumbs become the liveness signal) or as a
 *      dedicated `openclaw-whatsapp` process with its own heartbeat file.
 *
 *   2. Hermes: a session under `<configDir>/platforms/whatsapp/session`.
 *
 * The probe inspects both layouts, the heartbeat file, a bounded slice of
 * bridge logs, running processes, and the OpenClaw gateway log (which
 * whatsapp lines are scoped to via `channels/whatsapp` and `[whatsapp]`).
 * The gateway-log liveness markers synthesize a heartbeat when the in-process
 * bridge is up and has recorded inbound traffic without publishing a
 * heartbeat file — this closes the "paired-looking with no observable
 * inbound" gap reported in issue #4386 for the current OpenClaw in-process
 * bridge.
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
  parseWhatsappHeartbeat,
  summarizeWhatsappLogLines,
  type WhatsappHeartbeat,
  type WhatsappProbeInput,
} from "./status-health-eval";

export const WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID = "whatsapp.statusHealth";

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the inline diagnostic snippet. WhatsApp's bridge sometimes goes
// unresponsive when the Noise WebSocket is stuck; a fast hard cap keeps
// channels status from inheriting that hang.
const DEFAULT_TIMEOUT_MS = 8_000;

const SHELL_OK = "NEMOCLAW_WA_DIAG_OK";
const HEARTBEAT_BEGIN = "NEMOCLAW_WA_HEARTBEAT_BEGIN";
const HEARTBEAT_END = "NEMOCLAW_WA_HEARTBEAT_END";
const LOG_BEGIN = "NEMOCLAW_WA_LOG_BEGIN";
const LOG_END = "NEMOCLAW_WA_LOG_END";
const PROC_DONE = "NEMOCLAW_WA_PROC_DONE";
// Part 2 (gateway-log liveness for the in-process bridge): the probe emits
// only these two markers plus the extracted ISO timestamp — never a raw log
// line, so phone numbers embedded in an "Inbound message …" line cannot
// escape the sandbox. Scoped to whatsapp lines via `channels/whatsapp` and
// `[whatsapp]` so telegram breadcrumbs never get miscounted as WA liveness.
const GW_ALIVE = "NEMOCLAW_WA_GW_ALIVE";
const GW_LAST_INBOUND = "NEMOCLAW_WA_GW_LAST_INBOUND";

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
    const stateDirs = resolveWhatsappStateDirs(agent);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const script = buildWhatsappProbeScript(stateDirs);
    const exec = execute(sandboxName, script, timeoutMs);
    const parsed = parseProbeOutput(String(exec?.stdout ?? ""));
    // A non-zero exec (timeout/kill/unhealthy sandbox) can still carry partial
    // stdout that already contains the SHELL_OK marker (it is printed first),
    // so require a clean exit before trusting the probe. Otherwise a stalled
    // probe reads a verdict off partial data instead of classifying as
    // probe_failed. Mirrors the telegram status-health hook.
    const reachable = parsed.reachable && exec?.status === 0;

    let heartbeat: WhatsappHeartbeat | null = null;
    let heartbeatParseError: string | null = null;
    if (parsed.heartbeatRaw) {
      const parseResult = parseWhatsappHeartbeat(parsed.heartbeatRaw);
      if ("heartbeat" in parseResult) {
        heartbeat = parseResult.heartbeat;
      } else {
        heartbeatParseError = parseResult.parseError;
      }
    }

    // Part 2 (gateway-log liveness): when the probe found the whatsapp
    // provider listening in the gateway log, treat that as bridge liveness
    // — the in-process bridge does not show under pgrep. When there is no
    // heartbeat file but the gateway log shows recent inbound, synthesize a
    // minimal heartbeat so the "paired but no inbound observed" warning is
    // replaced with the actual last-inbound timestamp.
    let bridgeProcessAlive = parsed.bridgeProcessAlive;
    if (parsed.gatewayProviderAlive) {
      bridgeProcessAlive = true;
    }
    if (!heartbeat && parsed.gatewayProviderAlive) {
      heartbeat = {
        connectionState: "open",
        lastInboundAt: parsed.gatewayLastInboundAt,
        messagesHandled: null,
        noteCategory: null,
      };
    }

    const input: WhatsappProbeInput = {
      agent,
      stateDirs,
      stateDirPopulated: parsed.stateDirPopulated,
      heartbeat,
      heartbeatParseError,
      bridgeProcessAlive,
      recentLogSignals: summarizeWhatsappLogLines(parsed.logLines),
      probeReachable: reachable,
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
 * The two known WhatsApp bridge state layouts, keyed by agent name. The hook
 * has no AgentDefinition — the parent runner threads only serializable
 * facts through the manifest hook contract — so paths are derived from the
 * agent string and the fixed in-sandbox config dir convention. Non-existent
 * candidates simply yield "MISSING" in the probe output.
 */
export function resolveWhatsappStateDirs(agent: string): string[] {
  if (agent === "hermes") {
    return ["/sandbox/.hermes/platforms/whatsapp/session"];
  }
  // Default to the OpenClaw layout. OpenClaw 2026.6.10+ writes the paired
  // Baileys session under `credentials/whatsapp/<account>/creds.json`, not
  // `<configDir>/whatsapp`, so probe both shapes (Part 1 fix).
  return ["/sandbox/.openclaw/whatsapp", "/sandbox/.openclaw/credentials/whatsapp"];
}

function buildWhatsappProbeScript(stateDirs: readonly string[]): string {
  // The script:
  //  1. Marks success with SHELL_OK so we can disambiguate "exec failed" from
  //     "exec succeeded but produced nothing".
  //  2. Lists each candidate state directory and emits a single "POPULATED"
  //     or "EMPTY" / "MISSING" line per dir.
  //  3. Cats the first heartbeat-shaped file it finds, wrapped in begin/end
  //     markers so the parser can extract it without parsing find output.
  //  4. Tails up to 200 lines of bridge log files and forwards only short
  //     lines that match the diagnostic regex set. The host parser further
  //     filters to summary phrases.
  //  5. Scans the OpenClaw gateway log for whatsapp-scoped liveness lines
  //     (Part 2) — provider-ready plus the newest inbound timestamp — and
  //     emits only the fixed markers + the parsed ISO string. Never a raw
  //     log line: gateway inbound lines can carry phone numbers.
  //  6. Runs pgrep for known bridge process names, then filters out the probe
  //     shell itself and the pgrep call so the diagnostic does not report a
  //     bridge as "running" when the only match is our own command line.
  // The script is joined with newlines so the embedded `for` / `if`
  // constructs parse as compound statements. Joining the whole thing with
  // ` && ` corrupts the grammar (e.g. `do && if`), which `/bin/sh` rejects
  // before the SHELL_OK marker prints and every live probe gets misread as
  // unreachable. The leading `set +e` makes the probe survive missing log
  // files and empty pgrep matches without aborting at the first non-zero
  // exit.
  const quotedDirs = stateDirs.map(quotePath).join(" ");
  return [
    `set +e`,
    `printf '%s\\n' ${quotePath(SHELL_OK)}`,
    `for dir in ${quotedDirs}; do`,
    `  if [ ! -d "$dir" ]; then printf 'DIR %s MISSING\\n' "$dir"; continue; fi`,
    `  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then`,
    `    printf 'DIR %s EMPTY\\n' "$dir"`,
    `  else`,
    `    printf 'DIR %s POPULATED\\n' "$dir"`,
    `  fi`,
    `done`,
    `for dir in ${quotedDirs}; do`,
    `  for candidate in heartbeat.json status.json health.json bridge-status.json; do`,
    `    if [ -f "$dir/$candidate" ]; then`,
    `      printf '%s\\n' ${quotePath(HEARTBEAT_BEGIN)}`,
    `      cat "$dir/$candidate" 2>/dev/null | head -c 8192`,
    `      printf '\\n%s\\n' ${quotePath(HEARTBEAT_END)}`,
    `      break 2`,
    `    fi`,
    `  done`,
    `done`,
    `printf '%s\\n' ${quotePath(LOG_BEGIN)}`,
    `for dir in ${quotedDirs}; do`,
    `  for log in "$dir"/*.log "$dir"/logs/*.log; do`,
    `    [ -f "$log" ] || continue`,
    `    tail -n 200 "$log" 2>/dev/null | grep -E 'connection\\.(open|close|update|update.*restart)|ws (open|close)|401|unauthorized|qr.*(expired|timeout)|restartRequired|loggedOut|logged out|getMessage' | tail -n 20`,
    `  done`,
    `done`,
    `printf '%s\\n' ${quotePath(LOG_END)}`,
    // Part 2 (gateway-log liveness). The OpenClaw gateway log has whatsapp
    // lines like `... channels/whatsapp ... starting provider` and
    // `... [whatsapp] ... Inbound message from ...`. Scope grep to whatsapp
    // so telegram lines are not miscounted, and emit ONLY the markers +
    // the ISO timestamp — never a raw log line. For hermes runs the glob
    // finds no files and the block is a no-op.
    `for gwlog in /tmp/openclaw-*/openclaw-*.log; do`,
    `  [ -f "$gwlog" ] || continue`,
    `  __wa_scoped=$(tail -n 500 "$gwlog" 2>/dev/null | grep -E 'channels/whatsapp|\\[whatsapp\\]')`,
    `  printf '%s' "$__wa_scoped" | grep -qE 'starting provider|Listening for WhatsApp inbound' && printf '%s\\n' ${quotePath(GW_ALIVE)}`,
    `  __wa_last=$(printf '%s' "$__wa_scoped" | grep -E 'Inbound message' | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+([+-][0-9:]+|Z)?' | tail -n 1)`,
    `  [ -n "$__wa_last" ] && printf '%s %s\\n' ${quotePath(GW_LAST_INBOUND)} "$__wa_last"`,
    `done`,
    `__nemoclaw_wa_self_pid=$$`,
    // Match both process-name-with-whatsapp and processes whose argv
    // mentions the WhatsApp state directory or known plugin paths. A
    // bridge that runs inside the parent agent process (e.g. an OpenClaw
    // plugin loaded via a generic `node` entry point) usually carries the
    // platforms/whatsapp path on its command line via `--state-dir` or
    // similar.
    `pgrep -fa 'whatsapp|baileys|platforms/whatsapp|openclaw-whatsapp|hermes.*whatsapp' 2>/dev/null | awk -v self="$__nemoclaw_wa_self_pid" '$1 != self && $0 !~ /pgrep -fa/ && $0 !~ /NEMOCLAW_WA_DIAG_OK/ { print "PROC " $0 }' | head -n 5`,
    // Always emit PROC_DONE after the pgrep pipeline so the parser can tell
    // apart "pgrep completed with no matches" (the bridge runs under a
    // process name that does not contain `whatsapp` or `baileys`, or has
    // crashed) from "the probe never reached pgrep" (script aborted
    // mid-flight). Without this marker both cases collapse to `null`.
    `printf '%s\\n' ${quotePath(PROC_DONE)}`,
  ].join("\n");
}

type ParsedProbe = {
  reachable: boolean;
  stateDirPopulated: boolean | null;
  heartbeatRaw: string | null;
  logLines: string[];
  bridgeProcessAlive: boolean | null;
  gatewayProviderAlive: boolean;
  gatewayLastInboundAt: string | null;
};

function parseProbeOutput(stdout: string): ParsedProbe {
  const lines = stdout.split(/\r?\n/);
  if (!lines.includes(SHELL_OK)) {
    return {
      reachable: false,
      stateDirPopulated: null,
      heartbeatRaw: null,
      logLines: [],
      bridgeProcessAlive: null,
      gatewayProviderAlive: false,
      gatewayLastInboundAt: null,
    };
  }
  let stateDirPopulated: boolean | null = false;
  let sawAnyDir = false;
  let heartbeatRaw: string | null = null;
  let inHeartbeat = false;
  let inLogs = false;
  const heartbeatBuf: string[] = [];
  const logLines: string[] = [];
  let sawProcMatch = false;
  let sawProcDone = false;
  let gatewayProviderAlive = false;
  let gatewayLastInboundAt: string | null = null;

  for (const line of lines) {
    if (line === HEARTBEAT_BEGIN) {
      inHeartbeat = true;
      continue;
    }
    if (line === HEARTBEAT_END) {
      inHeartbeat = false;
      heartbeatRaw = heartbeatBuf.join("\n").trim();
      continue;
    }
    if (line === LOG_BEGIN) {
      inLogs = true;
      continue;
    }
    if (line === LOG_END) {
      inLogs = false;
      continue;
    }
    if (inHeartbeat) {
      heartbeatBuf.push(line);
      continue;
    }
    if (inLogs) {
      const trimmed = line.trim();
      if (trimmed.length > 0) logLines.push(trimmed);
      continue;
    }
    const dirMatch = line.match(/^DIR\s+\S+\s+(MISSING|EMPTY|POPULATED)$/);
    if (dirMatch) {
      sawAnyDir = true;
      if (dirMatch[1] === "POPULATED") stateDirPopulated = true;
      continue;
    }
    if (line.startsWith("PROC ")) {
      sawProcMatch = true;
      continue;
    }
    if (line === PROC_DONE) {
      sawProcDone = true;
      continue;
    }
    if (line === GW_ALIVE) {
      gatewayProviderAlive = true;
      continue;
    }
    if (line.startsWith(`${GW_LAST_INBOUND} `)) {
      gatewayLastInboundAt = line.slice(GW_LAST_INBOUND.length + 1).trim() || null;
      continue;
    }
  }
  // Three states:
  //   true  → pgrep printed at least one matching process
  //   false → pgrep completed with no matches; either the bridge is dead
  //           OR it runs inside the parent agent process under a name that
  //           does not contain `whatsapp`/`baileys`. The evaluator resolves
  //           that ambiguity using heartbeat freshness.
  //   null  → the probe aborted before reaching pgrep (timeout, exec
  //           failure); we cannot infer anything about the bridge state.
  const bridgeProcessAliveOut = sawProcMatch ? true : sawProcDone ? false : null;
  return {
    reachable: true,
    stateDirPopulated: sawAnyDir ? stateDirPopulated : null,
    heartbeatRaw,
    logLines,
    bridgeProcessAlive: bridgeProcessAliveOut,
    gatewayProviderAlive,
    gatewayLastInboundAt,
  };
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
