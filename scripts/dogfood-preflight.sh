#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Deterministic self-check preflight for the verify-stale dogfood. Runs
# the seven checks from .agents/skills/.../reference/self-check.md that
# DON'T require LLM judgment (token perms, idempotency, version validity,
# tool drift, cost budget, platform substitution, ollama reachability)
# against a specific candidate issue. The two LLM-judgment checks
# (reproducer-extractable, bug-class) are deferred to the agent itself.
#
# Usage:
#   dogfood-preflight.sh <issue-number> <reported-version-or-empty>
#
# Exit codes:
#   0 — PROCEED (all deterministic checks passed)
#   1 — SKIP (one or more checks failed; reason in JSON output)
#   2 — usage / dependency error
#
# Output: writes $VERIFY_STALE_LOG_DIR/<issue-number>/preflight.json with
# the per-check verdict and aggregate result. The orchestrator reads this
# file to decide whether to invoke the agent for this candidate.

set -euo pipefail

ISSUE="${1:-}"
REPORTED_VERSION_HINT="${2:-}"

[ -n "$ISSUE" ] || { echo "usage: $(basename "$0") <issue-number> [reported-version]" >&2; exit 2; }

# Strip leading # if present.
ISSUE="${ISSUE#\#}"

# Required env.
: "${VERIFY_STALE_LOG_DIR:?VERIFY_STALE_LOG_DIR not set}"
: "${BREV_BUDGET_USD:=200}"

ISSUE_DIR="$VERIFY_STALE_LOG_DIR/$ISSUE"
mkdir -p "$ISSUE_DIR"
OUT="$ISSUE_DIR/preflight.json"

# Accumulator for results. Start as a JSON object and update with jq.
echo '{
  "issue": "#'"$ISSUE"'",
  "ran_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
  "checks": {},
  "verdict": "PROCEED"
}' > "$OUT"

record_check() {
  local key="$1" status="$2" detail="${3:-}"
  jq --arg k "$key" --arg s "$status" --arg d "$detail" \
    '.checks[$k] = (if $d == "" then $s else "\($s): \($d)" end)' \
    "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  case "$status" in
    fail)
      # Accumulate failed-check names into skip_reasons (array); set verdict
      # to SKIP. Earlier impl used a single skip_reason string and the LAST
      # fail won, hiding earlier failures from the operator log.
      jq --arg k "$key" \
        '.verdict = "SKIP"
         | .skip_reasons = ((.skip_reasons // []) + [$k])
         | .skip_reason = "check failed: " + (.skip_reasons | join(", "))' \
        "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
      ;;
    caveat)
      # Only downgrade to PROCEED-WITH-CAVEATS if currently PROCEED. Use
      # `if` instead of `[ ] && ...` because the chain's exit status under
      # `set -e` would kill the script when the condition is false.
      local current
      current=$(jq -r '.verdict' "$OUT")
      if [ "$current" = "PROCEED" ]; then
        jq '.verdict = "PROCEED-WITH-CAVEATS"' "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Check 2 — Version validity (deterministic; only digit-portion known)
# ---------------------------------------------------------------------------
# Skipped if no reported version hint provided — the agent's Step 4 will
# parse from the issue body and the post-parse validation runs there.
if [ -n "$REPORTED_VERSION_HINT" ]; then
  V="$REPORTED_VERSION_HINT"
  [[ "$V" =~ ^v ]] || V="v$V"
  # Find LATEST from the live tag list (most recent v0.0.x).
  if ! command -v gh >/dev/null 2>&1; then
    record_check version_validity fail "gh CLI not in PATH"
  else
    if ! gh api repos/NVIDIA/NemoClaw/tags --paginate --jq '.[].name' > /tmp/nemoclaw-tags.txt 2>/dev/null; then
      record_check version_validity fail "could not list tags via gh api"
    elif ! grep -Fxq "$V" /tmp/nemoclaw-tags.txt; then
      record_check version_validity fail "reported version $V not in tag list"
    else
      LATEST=$(grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' /tmp/nemoclaw-tags.txt | sort -V | tail -1)
      if [ "$V" = "$LATEST" ] || [[ "$V" > "$LATEST" ]]; then
        record_check version_validity fail "reported $V >= latest $LATEST"
      else
        # Patch-level distance.
        R_PATCH="${V##*.}"
        L_PATCH="${LATEST##*.}"
        dist=$((L_PATCH - R_PATCH))
        if [ "$dist" -lt 2 ]; then
          record_check version_validity caveat "reported $V only $dist patch(es) behind $LATEST"
        else
          record_check version_validity pass "$V is $dist patches behind $LATEST"
        fi
      fi
    fi
  fi
else
  record_check version_validity caveat "no version hint; deferring to agent's Step 4 parser"
fi

# ---------------------------------------------------------------------------
# Check 4 — Provider reachable (only deterministic when ollama-only)
# ---------------------------------------------------------------------------
if [ "${VERIFY_STALE_FORCE_OLLAMA_ONLY:-0}" = "1" ]; then
  # The filter (Step 3) drops non-ollama candidates; here we just verify the
  # ollama endpoint is reachable from this sandbox.
  OLLAMA_URL="${OLLAMA_URL:-http://host.openshell.internal:11434}"
  if curl -sf -m 5 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    record_check provider_reachable pass "ollama reachable at $OLLAMA_URL"
  else
    record_check provider_reachable fail "ollama not reachable at $OLLAMA_URL (check local-inference policy + ollama running on host)"
  fi
else
  record_check provider_reachable caveat "non-ollama paths require LLM-side validation (deferred to agent)"
fi

# ---------------------------------------------------------------------------
# Check 5 — Platform substitution (deterministic from labels)
# ---------------------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  LABELS=$(gh issue view "$ISSUE" --repo NVIDIA/NemoClaw --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")
  case "$LABELS" in
    *"Platform: Windows"* | *"Platform: WSL"*) record_check platform_substitution fail "Windows/WSL — Brev has no equivalent" ;;
    *"Platform: MacOS"* | *"Platform: macOS"*) record_check platform_substitution fail "macOS — Brev has no equivalent" ;;
    *"Platform: Jetson"*) record_check platform_substitution fail "Jetson — no equivalent Brev SKU" ;;
    *"Platform: DGX Spark"* | *"Platform: GB10"*) record_check platform_substitution caveat "DGX Spark / GB10 — score caps at 60; Step 10 must include hardware-substitution caveat" ;;
    *) record_check platform_substitution pass "x86-Brev-compatible platform" ;;
  esac
else
  record_check platform_substitution fail "gh CLI not in PATH"
fi

# ---------------------------------------------------------------------------
# Check 7 — Cost budget (deterministic via remaining-budget file)
#
# Per-candidate projection uses the orchestrator's conservative rate
# (DOGFOOD_BREV_HOURLY_USD, default 3) × the skill's 60-min wallclock cap.
# The orchestrator updates .spent-usd after each candidate from actual
# wallclock, so this projection is purely the gate for whether to even
# attempt the next candidate.
# ---------------------------------------------------------------------------
SPENT_FILE="$VERIFY_STALE_LOG_DIR/.spent-usd"
SPENT_USD=$(cat "$SPENT_FILE" 2>/dev/null || echo 0)
HOURLY="${DOGFOOD_BREV_HOURLY_USD:-3}"
PER_CANDIDATE_CEIL="$HOURLY"   # 60-min cap × $HOURLY/hr ≈ $HOURLY at the ceiling
PROJECTED=$((SPENT_USD + PER_CANDIDATE_CEIL))
if [ "$PROJECTED" -gt "$BREV_BUDGET_USD" ]; then
  record_check cost_budget fail "projected $PROJECTED USD (\$$SPENT_USD spent + \$$PER_CANDIDATE_CEIL ceiling) exceeds budget \$$BREV_BUDGET_USD"
elif [ "$SPENT_USD" -gt $((BREV_BUDGET_USD / 2)) ]; then
  record_check cost_budget caveat "already at \$$SPENT_USD / \$$BREV_BUDGET_USD"
else
  record_check cost_budget pass "\$$SPENT_USD / \$$BREV_BUDGET_USD spent"
fi

# ---------------------------------------------------------------------------
# Check 8 — Token permissions (deterministic; both must succeed)
# ---------------------------------------------------------------------------
TOKEN_DETAIL=""
TOKEN_STATUS="pass"
if ! gh auth status >/dev/null 2>&1; then
  TOKEN_STATUS="fail"
  TOKEN_DETAIL="gh auth status failed"
else
  SCOPES=$(gh auth status 2>&1 | grep -oE "Token scopes: .*" || echo "")
  case "$SCOPES" in
    *repo*) ;;
    *) TOKEN_STATUS="fail"; TOKEN_DETAIL="missing repo scope: $SCOPES" ;;
  esac
  if [ "$TOKEN_STATUS" = "pass" ]; then
    case "$SCOPES" in
      *project*) ;;
      *) TOKEN_STATUS="caveat"; TOKEN_DETAIL="missing project scope; Project 199 move will warn-and-skip" ;;
    esac
  fi
fi
if ! brev ls >/dev/null 2>&1; then
  if [ "$TOKEN_STATUS" = "pass" ]; then
    TOKEN_STATUS="fail"
    TOKEN_DETAIL="brev ls failed (BREV_API_TOKEN invalid or brev preset not allowing egress)"
  else
    TOKEN_DETAIL="$TOKEN_DETAIL; brev ls failed"
  fi
fi
record_check token_perms "$TOKEN_STATUS" "$TOKEN_DETAIL"

# ---------------------------------------------------------------------------
# Check 9 — Idempotency (deterministic from issue comments + labels)
# ---------------------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  LABEL_HIT=$(echo "${LABELS:-}" | grep -oE 'fixed-on-latest|verify-inconclusive' | head -1 || echo "")
  if [ -n "$LABEL_HIT" ]; then
    record_check idempotency fail "issue already labeled $LABEL_HIT"
  else
    # Recent marker check. `gh issue view --jq` does not accept `--arg` (the
    # `gh` parser stops at the first positional after `--jq`), so pipe through
    # standalone jq with --arg.
    SEVEN_DAYS_AGO=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-7 days' +%Y-%m-%dT%H:%M:%SZ)
    RECENT_MARKER=$(gh issue view "$ISSUE" --repo NVIDIA/NemoClaw --json comments --jq '.comments' \
      | jq --arg cutoff "$SEVEN_DAYS_AGO" \
        'map(select(.body | test("<!-- nemoclaw-verify-stale v[0-9]+ [0-9-]+ -->"))) |
         map(select(.createdAt > $cutoff)) | length' 2>/dev/null || echo 0)
    if [ "$RECENT_MARKER" -gt 0 ]; then
      record_check idempotency fail "marker posted within last 7 days"
    else
      record_check idempotency pass "no recent marker; no fixed-on-latest/verify-inconclusive label"
    fi
  fi
else
  record_check idempotency fail "gh CLI not in PATH"
fi

# ---------------------------------------------------------------------------
# Defer LLM-judgment checks. The agent runs Step 3 (self-check.md) which
# covers reproducer-extractable, bug-class, and tool-drift — those require
# reading the issue body and reasoning.
# ---------------------------------------------------------------------------
record_check reproducer_extractable caveat "deferred to agent's Step 3 self-check"
record_check bug_class caveat "deferred to agent's Step 3 self-check"
record_check tool_drift caveat "deferred to agent's Step 8d.5 architectural-drift check"

# ---------------------------------------------------------------------------
# Final verdict + exit code
# ---------------------------------------------------------------------------
FINAL=$(jq -r '.verdict' "$OUT")
case "$FINAL" in
  PROCEED|PROCEED-WITH-CAVEATS) exit 0 ;;
  SKIP) exit 1 ;;
  *) echo "unexpected verdict: $FINAL" >&2; exit 2 ;;
esac
