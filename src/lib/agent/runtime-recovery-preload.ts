// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway recovery preload repair logic. The generated shell restores the two
// critical Node preload guards from the packaged image copies before recovery
// relaunches a gateway.

export const GATEWAY_PRELOAD_GUARDS: ReadonlyArray<{
  tmpPath: string;
  sourcePath: string;
}> = [
  {
    tmpPath: "/tmp/nemoclaw-sandbox-safety-net.js",
    sourcePath: "/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js",
  },
  {
    tmpPath: "/tmp/nemoclaw-ciao-network-guard.js",
    sourcePath: "/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js",
  },
];

/**
 * Build shell lines that restore and validate the required recovery preloads.
 *
 * The recovery script sources /tmp/nemoclaw-proxy-env.sh before these lines.
 * If that file is missing, this helper recreates a minimal proxy-env file from
 * trusted packaged preload sources, sources it, and leaves the sandbox in a
 * state the E2E guard-chain checks can inspect. If the trusted sources cannot
 * be staged safely, callers see _GUARDS_MISSING=1 and refuse the relaunch.
 */
export function buildGatewayGuardRecoveryLines(): string[] {
  const recoveredProxyEnvExports = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) =>
      `printf '%s\\n' 'export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--require ${tmpPath}"';`,
  );
  const stageCalls = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath, sourcePath }) =>
      `_nemoclaw_stage_recovery_preload ${tmpPath} ${sourcePath} || _NEMOCLAW_CRITICAL_GUARDS_READY=0;`,
  );
  const appendCalls = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) =>
      `if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ]; then _nemoclaw_append_node_require ${tmpPath}; fi;`,
  );
  const guardChecks = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath }) => `_nemoclaw_node_options_has_require ${tmpPath} || _GUARDS_MISSING=1;`,
  );

  const helpers = [
    "_nemoclaw_recovery_log() {",
    'local _msg="$1";',
    'echo "$_msg" >&2;',
    'if [ -n "${_GATEWAY_LOG:-}" ]; then echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null || true; fi;',
    "};",
    "_nemoclaw_node_options_has_require() {",
    'local wanted="$1"; local token prev;',
    "prev=;",
    "for token in ${NODE_OPTIONS:-}; do",
    'if [ "$prev" = "--require" ] && [ "$token" = "$wanted" ]; then return 0; fi;',
    'if [ "$token" = "--require=$wanted" ]; then return 0; fi;',
    'prev="$token";',
    "done;",
    "return 1;",
    "};",
    "_nemoclaw_append_node_require() {",
    'local wanted="$1";',
    'if ! _nemoclaw_node_options_has_require "$wanted"; then export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $wanted"; fi;',
    "};",
    "_nemoclaw_validate_recovery_preload() {",
    'local file="$1"; local perms owner _msg;',
    'if [ -L "$file" ]; then _msg="[gateway-recovery] ERROR: $file is a symlink - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ ! -f "$file" ]; then _msg="[gateway-recovery] ERROR: $file is not a regular file - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'perms="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || echo unknown)";',
    'if [ "$perms" != "444" ]; then _msg="[gateway-recovery] ERROR: $file has unsafe mode=$perms (expected 444) - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ]; then',
    'owner="$(stat -c %U "$file" 2>/dev/null || stat -f %Su "$file" 2>/dev/null || echo unknown)";',
    'if [ "$owner" != "root" ]; then _msg="[gateway-recovery] ERROR: $file owner=$owner (expected root) - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    "fi;",
    "return 0;",
    "};",
    "_nemoclaw_stage_recovery_preload() {",
    'local tmp="$1"; local src="$2"; local dir base stage _msg;',
    'if [ ! -r "$src" ] || [ -L "$src" ] || [ ! -f "$src" ]; then _msg="[gateway-recovery] ERROR: trusted preload source $src unavailable - refusing preload install"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'dir="$(dirname "$tmp")"; base="$(basename "$tmp")";',
    'stage="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || { _msg="[gateway-recovery] ERROR: failed to stage $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; };',
    'if ! cp "$src" "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to copy $src into recovery stage"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ] && ! chown root:root "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chown recovery stage for $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! chmod 444 "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chmod recovery stage for $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! mv -f "$stage" "$tmp"; then rm -f "$stage"; if _nemoclaw_validate_recovery_preload "$tmp"; then return 0; fi; _msg="[gateway-recovery] ERROR: failed to install recovery preload $tmp"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    '_nemoclaw_validate_recovery_preload "$tmp";',
    "};",
    "_nemoclaw_write_recovered_proxy_env() {",
    "local env_file=/tmp/nemoclaw-proxy-env.sh; local stage _msg;",
    'stage="$(mktemp /tmp/.nemoclaw-proxy-env.sh.tmp.XXXXXX)" || { _msg="[gateway-recovery] ERROR: failed to stage recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; };',
    "{",
    "printf '%s\\n' '# Recovered by NemoClaw gateway recovery; sandbox restart refreshes the full proxy env.';",
    ...recoveredProxyEnvExports,
    '} > "$stage" || { rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to write recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; };',
    'if [ "$(id -u)" -eq 0 ] && ! chown root:root "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chown recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! chmod 444 "$stage"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to chmod recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    'if ! mv -f "$stage" "$env_file"; then rm -f "$stage"; _msg="[gateway-recovery] ERROR: failed to install recovered proxy-env.sh"; _nemoclaw_recovery_log "$_msg"; return 1; fi;',
    "return 0;",
    "};",
  ].join(" ");

  return [
    helpers,
    "_NEMOCLAW_CRITICAL_GUARDS_READY=1;",
    ...stageCalls,
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ] && [ "${_PE_MISSING:-0}" = "1" ]; then',
    '_W="[gateway-recovery] WARNING: /tmp/nemoclaw-proxy-env.sh missing - restoring library guards from packaged preloads (#2478/#2701)"; _nemoclaw_recovery_log "$_W";',
    "_nemoclaw_write_recovered_proxy_env || _NEMOCLAW_CRITICAL_GUARDS_READY=0;",
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" = "1" ]; then . /tmp/nemoclaw-proxy-env.sh; _PE_MISSING=0; fi;',
    "fi;",
    ...appendCalls,
    "_GUARDS_MISSING=0;",
    'if [ "$_NEMOCLAW_CRITICAL_GUARDS_READY" != "1" ]; then _GUARDS_MISSING=1; fi;',
    ...guardChecks,
  ];
}
