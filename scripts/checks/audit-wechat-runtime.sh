#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime_dir="$repo_root/agents/openclaw/wechat-runtime"
report_dir="${1:-$repo_root/artifacts/wechat-runtime-audit}"
trusted_cache="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-wechat-trusted-cache.XXXXXX")"
install_cache="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-wechat-install-cache.XXXXXX")"
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-wechat-pack.XXXXXX")"
wechat_spec="@tencent-weixin/openclaw-weixin@2.4.3"
wechat_tarball="https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz"
wechat_integrity="sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw=="

cleanup() {
  chmod -R u+w "$trusted_cache" "$install_cache" "$pack_dir" 2>/dev/null || true
  rm -rf "$trusted_cache" "$install_cache" "$pack_dir" "$runtime_dir/node_modules"
}
trap cleanup EXIT

mkdir -p "$report_dir"

# Materialize the same production graph and cache inputs used by Dockerfile.
npm --prefix "$runtime_dir" ci \
  --ignore-scripts \
  --omit=dev \
  --legacy-peer-deps \
  --no-audit \
  --no-fund \
  --cache "$trusted_cache"
for package_spec in "$wechat_spec" "qrcode-terminal@0.12.0" "zod@4.4.3"; do
  npm cache add "$package_spec" --cache "$trusted_cache"
done

audit_status=0
npm --prefix "$runtime_dir" audit \
  --omit=dev \
  --audit-level=low \
  --json >"$report_dir/npm-audit.json" || audit_status=$?

signature_status=0
npm --prefix "$runtime_dir" audit signatures \
  >"$report_dir/npm-audit-signatures.txt" 2>&1 || signature_status=$?

# Reproduce the sandbox-user npm-pack boundary with the exact reviewed archive.
# The trusted source cache is read-only; only its short-lived copy is writable.
chmod -R a-w "$trusted_cache"
cp -R "$trusted_cache"/. "$install_cache"/
chmod -R u+rwX,go-w "$install_cache"
npm pack "$wechat_tarball" \
  --offline \
  --cache "$install_cache" \
  --pack-destination "$pack_dir" \
  --json >"$report_dir/npm-pack.json"

TRUSTED_CACHE="$trusted_cache" \
  PACK_DIR="$pack_dir" \
  PACK_REPORT="$report_dir/npm-pack.json" \
  EXPECTED_INTEGRITY="$wechat_integrity" \
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const trustedCache = process.env.TRUSTED_CACHE;
const packDir = path.resolve(process.env.PACK_DIR);
const report = JSON.parse(fs.readFileSync(process.env.PACK_REPORT, "utf8"));
const entry = report[0] ?? {};
if (entry.integrity !== process.env.EXPECTED_INTEGRITY) {
  throw new Error(`reviewed WeChat archive integrity mismatch: ${entry.integrity ?? "missing"}`);
}
const filename = String(entry.filename ?? "");
if (!filename || path.basename(filename) !== filename) {
  throw new Error(`npm pack reported an unsafe filename: ${filename || "missing"}`);
}
const archive = path.resolve(packDir, filename);
if (!archive.startsWith(`${packDir}${path.sep}`) || !fs.statSync(archive).isFile()) {
  throw new Error(`npm pack archive escaped its destination: ${filename}`);
}

const pending = [trustedCache];
while (pending.length > 0) {
  const current = pending.pop();
  const stats = fs.lstatSync(current);
  if ((stats.mode & 0o222) !== 0) {
    throw new Error(`trusted WeChat cache entry remained writable: ${current}`);
  }
  if (stats.isDirectory()) {
    for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
  }
}
NODE

if ((audit_status != 0)); then
  echo "WeChat runtime npm audit failed at audit-level=low; see $report_dir/npm-audit.json" >&2
  exit "$audit_status"
fi
if ((signature_status != 0)); then
  echo "WeChat runtime npm signature audit failed; see $report_dir/npm-audit-signatures.txt" >&2
  exit "$signature_status"
fi

echo "WeChat runtime graph, audit, signatures, and writable install-cache boundary passed."
