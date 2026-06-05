#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helpers for inference-switch E2Es that need a compatible Anthropic
# Messages provider. The mock provider runs on the host; agents still reach it
# only through OpenShell-managed inference.local.

ANTHROPIC_SWITCH_MOCK_PID=""
ANTHROPIC_SWITCH_MOCK_LOG="${ANTHROPIC_SWITCH_MOCK_LOG:-/tmp/nemoclaw-e2e-anthropic-switch-provider.log}"

parse_anthropic_content() {
  python3 -c '
import json, sys
try:
    r = json.load(sys.stdin)
    parts = r.get("content") or []
    text = []
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            text.append(part["text"])
    print(" ".join(text).strip())
except Exception as e:
    print(f"PARSE_ERROR: {e}", file=sys.stderr)
    sys.exit(1)
'
}

start_mock_anthropic_switch_provider() {
  local port="${SWITCH_MOCK_PORT:-18766}"
  SWITCH_ENDPOINT_URL="http://127.0.0.1:${port}"
  export SWITCH_ENDPOINT_URL

  python3 - "$port" >"$ANTHROPIC_SWITCH_MOCK_LOG" 2>&1 <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write((fmt % args) + "\n")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
            return
        if self.path in ("/v1/models", "/v1/models/mock-anthropic-model"):
            self._json(200, {"data": [{"id": "mock-anthropic-model"}]})
            return
        self._json(404, {"error": "not found", "path": self.path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if self.path != "/v1/messages":
            self._json(404, {"error": "unexpected path", "path": self.path})
            return
        model = payload.get("model") or "mock-anthropic-model"
        self._json(200, {
            "id": "msg_mock",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": "PONG"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        })

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
  ANTHROPIC_SWITCH_MOCK_PID=$!

  local attempt=1
  while [ "$attempt" -le 5 ]; do
    if curl -sf --max-time 2 "${SWITCH_ENDPOINT_URL}/health" >/dev/null 2>&1; then
      pass "Mock Anthropic Messages provider is listening on ${SWITCH_ENDPOINT_URL}"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  fail "Mock Anthropic Messages provider did not start; log: ${ANTHROPIC_SWITCH_MOCK_LOG}"
  return 1
}

stop_mock_anthropic_switch_provider() {
  if [ -n "${ANTHROPIC_SWITCH_MOCK_PID:-}" ]; then
    kill "$ANTHROPIC_SWITCH_MOCK_PID" >/dev/null 2>&1 || true
    wait "$ANTHROPIC_SWITCH_MOCK_PID" >/dev/null 2>&1 || true
    ANTHROPIC_SWITCH_MOCK_PID=""
  fi
}

ensure_compatible_anthropic_switch_provider() {
  if [ "${SWITCH_PROVIDER:-}" != "compatible-anthropic-endpoint" ]; then
    return 0
  fi
  if [ "${SWITCH_INFERENCE_API:-}" != "anthropic-messages" ]; then
    return 0
  fi

  if [ "${SWITCH_MOCK_ANTHROPIC:-}" = "1" ]; then
    start_mock_anthropic_switch_provider || return 1
    export COMPATIBLE_ANTHROPIC_API_KEY="${COMPATIBLE_ANTHROPIC_API_KEY:-test-compatible-anthropic-key}"
  elif [ -z "${COMPATIBLE_ANTHROPIC_API_KEY:-}" ] && [ -n "${NVIDIA_API_KEY:-}" ]; then
    export COMPATIBLE_ANTHROPIC_API_KEY="$NVIDIA_API_KEY"
  fi

  if [ -z "${SWITCH_ENDPOINT_URL:-}" ]; then
    fail "NEMOCLAW_SWITCH_ENDPOINT_URL is required for compatible Anthropic inference switches"
    return 1
  fi
  if [ -z "${COMPATIBLE_ANTHROPIC_API_KEY:-}" ]; then
    fail "COMPATIBLE_ANTHROPIC_API_KEY is required for compatible Anthropic inference switches"
    return 1
  fi

  if openshell provider get -g nemoclaw compatible-anthropic-endpoint >/dev/null 2>&1; then
    openshell provider update -g nemoclaw compatible-anthropic-endpoint \
      --credential COMPATIBLE_ANTHROPIC_API_KEY \
      --config "ANTHROPIC_BASE_URL=${SWITCH_ENDPOINT_URL}" >/dev/null
  else
    openshell provider create -g nemoclaw \
      --name compatible-anthropic-endpoint \
      --type anthropic \
      --credential COMPATIBLE_ANTHROPIC_API_KEY \
      --config "ANTHROPIC_BASE_URL=${SWITCH_ENDPOINT_URL}" >/dev/null
  fi
  pass "OpenShell provider compatible-anthropic-endpoint is registered for ${SWITCH_ENDPOINT_URL}"
}
