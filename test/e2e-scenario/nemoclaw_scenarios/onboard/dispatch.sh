#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard dispatcher. Sources env.sh + context.sh + the three per-path
# worker files, defines `e2e_onboard()` which routes by onboarding
# profile id and honors dry-run.

_E2E_ONBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_ONBOARD_RUNTIME_LIB="$(cd "${_E2E_ONBOARD_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_ONBOARD_RUNTIME_LIB}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_ONBOARD_RUNTIME_LIB}/context.sh"
# shellcheck source=cloud-openclaw.sh
. "${_E2E_ONBOARD_DIR}/cloud-openclaw.sh"
# shellcheck source=cloud-openclaw-no-docker.sh
. "${_E2E_ONBOARD_DIR}/cloud-openclaw-no-docker.sh"
# shellcheck source=cloud-hermes.sh
. "${_E2E_ONBOARD_DIR}/cloud-hermes.sh"
# shellcheck source=local-ollama-openclaw.sh
. "${_E2E_ONBOARD_DIR}/local-ollama-openclaw.sh"

_E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID=""

e2e_onboard_validate_gateway_conflict_port() {
  local port="${1:-}"
  if [[ ! "${port}" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    echo "e2e_onboard: invalid gateway conflict port: ${port}" >&2
    return 2
  fi
}

e2e_onboard_gateway_port_is_reachable() {
  local port="${1:-}"
  node -e 'const net=require("node:net"); const port=Number(process.argv[1]); const socket=net.connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); process.exit(0); }); socket.once("error", () => process.exit(1)); setTimeout(() => process.exit(1), 250);' "${port}" >/dev/null 2>&1
}

e2e_onboard_start_gateway_port_holder() {
  local port="${1:-}"
  local log_path="${E2E_CONTEXT_DIR:-.e2e}/gateway-port-holder-${port}.log"
  mkdir -p "$(dirname "${log_path}")"
  node - "${port}" <<'NODE' >"${log_path}" 2>&1 &
const net = require("node:net");
const port = Number(process.argv[2]);
const server = net.createServer((socket) => socket.end());
server.on("error", (error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(2);
});
server.listen(port, "127.0.0.1", () => {
  console.log("ready");
});
setInterval(() => {}, 1000);
NODE
  printf '%s\n' "$!"
}

e2e_onboard_cleanup_gateway_port_holder() {
  if [[ -n "${_E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID}" ]]; then
    kill "${_E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID}" >/dev/null 2>&1 || true
    wait "${_E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID}" >/dev/null 2>&1 || true
    _E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID=""
  fi
}

e2e_onboard_cloud_openclaw_gateway_port_conflict() {
  local port="${NEMOCLAW_ONBOARD_NEGATIVE_CONFLICT_PORT:-18080}"
  e2e_onboard_validate_gateway_conflict_port "${port}" || return 2
  trap e2e_onboard_cleanup_gateway_port_holder EXIT INT TERM
  if ! e2e_onboard_gateway_port_is_reachable "${port}"; then
    _E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID="$(e2e_onboard_start_gateway_port_holder "${port}")"
    local attempts=0
    while ((attempts < 40)); do
      if e2e_onboard_gateway_port_is_reachable "${port}"; then
        break
      fi
      if ! kill -0 "${_E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID}" >/dev/null 2>&1; then
        _E2E_ONBOARD_GATEWAY_PORT_HOLDER_PID=""
        trap - EXIT INT TERM
        echo "e2e_onboard: gateway port holder exited before port ${port} became reachable" >&2
        return 2
      fi
      sleep 0.25
      attempts=$((attempts + 1))
    done
    if ! e2e_onboard_gateway_port_is_reachable "${port}"; then
      e2e_onboard_cleanup_gateway_port_holder
      trap - EXIT INT TERM
      echo "e2e_onboard: failed to hold gateway port ${port}" >&2
      return 2
    fi
  fi

  local status=0
  NEMOCLAW_GATEWAY_PORT="${port}" NEMOCLAW_POLICY_MODE=skip e2e_onboard_cloud_openclaw || status=$?
  e2e_onboard_cleanup_gateway_port_holder
  trap - EXIT INT TERM
  return "${status}"
}

e2e_onboard_cloud_openclaw_invalid_nvidia_key() {
  NVIDIA_API_KEY=not-a-nvidia-key NEMOCLAW_POLICY_MODE=skip e2e_onboard_cloud_openclaw
}

e2e_onboard() {
  local profile="${1:-}"
  if [[ -z "${profile}" ]]; then
    echo "e2e_onboard: missing onboarding profile id" >&2
    return 2
  fi
  e2e_env_trace "onboard:${profile}"
  case "${profile}" in
    cloud-openclaw)
      e2e_onboard_cloud_openclaw
      ;;
    cloud-openclaw-no-docker)
      e2e_onboard_cloud_openclaw_no_docker
      ;;
    cloud-openclaw-custom-policies)
      E2E_ONBOARDING_MODEL="${E2E_ONBOARDING_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
      E2E_ONBOARDING_POLICY_PRESETS="${E2E_ONBOARDING_POLICY_PRESETS:-npm,pypi}"
      e2e_context_set E2E_ONBOARDING_MODEL "${E2E_ONBOARDING_MODEL}"
      e2e_context_set E2E_ONBOARDING_POLICY_PRESETS "${E2E_ONBOARDING_POLICY_PRESETS}"
      e2e_context_set E2E_ONBOARDING_REGISTRY_PROVIDER "nvidia-prod"
      NEMOCLAW_MODEL="${E2E_ONBOARDING_MODEL}" NEMOCLAW_POLICY_MODE=custom NEMOCLAW_POLICY_PRESETS="${E2E_ONBOARDING_POLICY_PRESETS}" e2e_onboard_cloud_openclaw
      ;;
    cloud-openclaw-invalid-nvidia-key)
      e2e_onboard_cloud_openclaw_invalid_nvidia_key
      ;;
    cloud-openclaw-gateway-port-conflict)
      e2e_onboard_cloud_openclaw_gateway_port_conflict
      ;;
    cloud-hermes)
      e2e_onboard_cloud_hermes
      ;;
    local-ollama-openclaw)
      e2e_onboard_local_ollama_openclaw
      ;;
    *)
      echo "e2e_onboard: unsupported onboarding profile: ${profile}" >&2
      return 2
      ;;
  esac
}
