#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Managed Deep Agents Code launcher for NemoClaw/OpenShell sandboxes.

set -euo pipefail

export HOME=/sandbox
export PATH="/usr/local/bin:${PATH}"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"

run_dcode() {
  exec python3 -m deepagents_code "$@"
}

is_managed_secret_key() {
  case "$1" in
    SLACK_BOT_TOKEN | SLACK_APP_TOKEN)
      return 0
      ;;
  esac
  return 1
}

is_secret_shaped_value() {
  local value="$1"
  [[ "$value" =~ ^nvapi-[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^nvcf-[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^ghp_[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^github_pat_[A-Za-z0-9_]{30,}$ ]] && return 0
  [[ "$value" =~ ^sk-proj-[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^sk-ant-[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]] && return 0
  [[ "$value" =~ ^xox[bpas]-[A-Za-z0-9-]{10,}$ ]] && return 0
  [[ "$value" =~ ^xapp-[A-Za-z0-9-]{10,}$ ]] && return 0
  [[ "$value" =~ ^AKIA[A-Z0-9]{16}$ ]] && return 0
  [[ "$value" =~ ^ASIA[A-Z0-9]{16}$ ]] && return 0
  [[ "$value" =~ ^hf_[A-Za-z0-9]{10,}$ ]] && return 0
  [[ "$value" =~ ^glpat-[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^gsk_[A-Za-z0-9]{10,}$ ]] && return 0
  [[ "$value" =~ ^pypi-[A-Za-z0-9_-]{10,}$ ]] && return 0
  return 1
}

refuse_secret_shaped_value() {
  local source="$1"
  local key="$2"
  printf "NemoClaw refuses to start Deep Agents Code: %s contains secret-shaped value for %s. Use \`nemoclaw credentials\` to register provider keys instead.\n" "$source" "$key" >&2
  exit 2
}

assert_no_secret_runtime_env() {
  local key value
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    if is_managed_secret_key "$key"; then
      continue
    fi
    if is_secret_shaped_value "${value:-}"; then
      refuse_secret_shaped_value "runtime environment" "$key"
    fi
  done < <(env)
}

assert_no_secret_env_file() {
  local env_file="${DEEPAGENTS_ENV_FILE:-/sandbox/.deepagents/.env}"
  [ -f "$env_file" ] || return 0

  local line raw_key key value refused_key=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#export }"
    case "$line" in
      "" | \#*)
        continue
        ;;
      *=*)
        raw_key="${line%%=*}"
        value="${line#*=}"
        key="$(printf '%s' "$raw_key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        [ -n "$key" ] || continue
        if is_managed_secret_key "$key"; then
          continue
        fi
        if is_secret_shaped_value "$value"; then
          refused_key="$key"
          break
        fi
        ;;
    esac
  done <"$env_file"
  if [ -n "$refused_key" ]; then
    refuse_secret_shaped_value "$env_file" "$refused_key"
  fi
}

assert_non_interactive_prompt_not_empty() {
  local arg value expect_value=0
  for arg in "$@"; do
    if [ "$expect_value" = "1" ]; then
      value="$arg"
      if [ -z "${value//[[:space:]]/}" ]; then
        printf 'NemoClaw refuses empty Deep Agents Code non-interactive prompts; provide a non-empty prompt.\n' >&2
        exit 2
      fi
      expect_value=0
      continue
    fi
    case "$arg" in
      -n | --non-interactive)
        expect_value=1
        ;;
      --non-interactive=*)
        value="${arg#--non-interactive=}"
        if [ -z "${value//[[:space:]]/}" ]; then
          printf 'NemoClaw refuses empty Deep Agents Code non-interactive prompts; provide a non-empty prompt.\n' >&2
          exit 2
        fi
        ;;
      -n?*)
        value="${arg#-n}"
        if [ -z "${value//[[:space:]]/}" ]; then
          printf 'NemoClaw refuses empty Deep Agents Code non-interactive prompts; provide a non-empty prompt.\n' >&2
          exit 2
        fi
        ;;
    esac
  done

  if [ "$expect_value" = "1" ]; then
    printf 'NemoClaw refuses empty Deep Agents Code non-interactive prompts; provide a non-empty prompt.\n' >&2
    exit 2
  fi
}

assert_no_secret_runtime_env
assert_no_secret_env_file
assert_non_interactive_prompt_not_empty "$@"

case "${1:-}" in
  --version | -v | -V | --help | -h)
    run_dcode "$@"
    ;;
esac

unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST

reject_managed_override() {
  local posture="$1"
  local arg="$2"
  printf 'NemoClaw manages Deep Agents Code %s; remove %s and use NemoClaw policy/configuration instead.\n' "$posture" "$arg" >&2
  exit 2
}

if [ "${1:-}" = "mcp" ]; then
  reject_managed_override "MCP posture" "mcp"
fi

for arg in "$@"; do
  case "$arg" in
    --sandbox | --sandbox=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-id | --sandbox-id=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-snapshot-name | --sandbox-snapshot-name=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-setup | --sandbox-setup=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --mcp-config | --mcp-config=* | --trust-project-mcp | --no-mcp=*)
      reject_managed_override "MCP posture" "$arg"
      ;;
    --shell-allow-list | --shell-allow-list=* | -S | -S?*)
      reject_managed_override "shell allow-list posture" "$arg"
      ;;
  esac
done

extra_args=(--sandbox none --no-mcp)

run_dcode "${extra_args[@]}" "$@"
