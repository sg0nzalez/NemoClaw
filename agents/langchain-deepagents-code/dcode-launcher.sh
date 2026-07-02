#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Proxy-normalizing launcher for every managed Deep Agents Code entry point.

set -euo pipefail

readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"
export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# Raw OpenShell exec processes do not inherit the entrypoint's environment or
# source shell startup files. Rebuild the managed proxy contract here so
# `nemoclaw <sandbox> exec -- dcode` cannot retain the sandbox-create host proxy
# seed (including NO_PROXY=inference.local). Host/port are non-secret image ENV
# values patched at build time and validated again before use.
PROXY_HOST="${NEMOCLAW_PROXY_HOST:-10.200.0.1}"
PROXY_PORT="${NEMOCLAW_PROXY_PORT:-3128}"

is_valid_proxy_host() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]]
}

is_valid_proxy_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || return 1
  ((10#$value >= 1 && 10#$value <= 65535))
}

if ! is_valid_proxy_host "$PROXY_HOST"; then
  printf '%s\n' 'Invalid NEMOCLAW_PROXY_HOST for the managed runtime proxy.' >&2
  exit 1
fi
if ! is_valid_proxy_port "$PROXY_PORT"; then
  printf '%s\n' 'Invalid NEMOCLAW_PROXY_PORT for the managed runtime proxy.' >&2
  exit 1
fi

_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"

exec "$MANAGED_DCODE_WRAPPER" "$@"
