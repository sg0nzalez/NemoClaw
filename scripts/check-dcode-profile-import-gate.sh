#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly base_image="${NEMOCLAW_DCODE_PROFILE_GATE_BASE_IMAGE:-ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest}"
readonly image_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
readonly stripped_image="nemoclaw-dcode-profile-missing-dependencies:${image_suffix}"
readonly failed_image="nemoclaw-dcode-profile-import-gate-failure:${image_suffix}"
build_log="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-dcode-profile-import-gate.XXXXXX.log")"
readonly build_log

cleanup() {
  docker image rm --force "${failed_image}" "${stripped_image}" >/dev/null 2>&1 || true
  rm -f "${build_log}"
}
trap cleanup EXIT

cd "${repo_root}"

docker build \
  --progress=plain \
  --file test/Dockerfile.dcode-profile-missing-dependencies \
  --build-arg "BASE_IMAGE=${base_image}" \
  --tag "${stripped_image}" \
  .

if docker build \
  --progress=plain \
  --file agents/langchain-deepagents-code/Dockerfile \
  --build-arg "BASE_IMAGE=${stripped_image}" \
  --tag "${failed_image}" \
  . 2>&1 | tee "${build_log}"; then
  echo "ERROR: DCode production image unexpectedly built without deepagents dependencies" >&2
  exit 1
fi

if ! grep -Fq "NEMOCLAW_DCODE_PROFILE_IMPORT_GATE" "${build_log}"; then
  echo "ERROR: DCode build failed before reaching the profile import gate" >&2
  exit 1
fi

if ! grep -Fq "ModuleNotFoundError: No module named 'deepagents'" "${build_log}"; then
  echo "ERROR: DCode build did not fail on the expected missing Deep Agents import" >&2
  exit 1
fi

echo "DCode profile import gate rejected a base missing deepagents and deepagents-code"
