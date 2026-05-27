#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Dogfood orchestrator for the verify-stale skill.
#
# Runs INSIDE the maintainer sandbox started by `nemoclaw onboard`. Validates
# the environment, installs missing CLIs, drives the verify-stale skill via
# per-candidate `openclaw agent` invocations with budget control between
# each, sweeps stragglers, and posts a wrap-up Gist.
#
# Operator flow (HOST machine):
#     cp scripts/dogfood-env.sh.example scripts/dogfood-env.sh
#     # edit secrets and switches in scripts/dogfood-env.sh
#     source scripts/dogfood-env.sh
#     ollama pull "$OLLAMA_MODEL"        # one-time, on host
#     nemoclaw onboard                   # uses canonical blueprint.yaml
#     # ... then inside the running sandbox:
#     source /sandbox/.openclaw/workspace/scripts/dogfood-env.sh
#     bash /sandbox/.openclaw/workspace/scripts/dogfood-orchestrator.sh

set -euo pipefail

# -----------------------------------------------------------------------------
# Style helpers — match scripts/backup-workspace.sh conventions
# -----------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[dogfood]${NC} $1"; }
warn() { echo -e "${YELLOW}[dogfood]${NC} $1" >&2; }
fail() {
  echo -e "${RED}[dogfood]${NC} $1" >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "env var '$name' is required but not set. Did you 'source scripts/dogfood-env.sh'?"
}

# -----------------------------------------------------------------------------
# Phase 1 — env validation
# -----------------------------------------------------------------------------

info "Phase 1 — env validation"

require_env BREV_API_TOKEN
require_env GH_TOKEN
require_env VERIFY_STALE_AUTO_APPROVE
require_env VERIFY_STALE_DRY_RUN
require_env VERIFY_STALE_BATCH_CAP
require_env VERIFY_STALE_LOG_DIR
require_env BREV_BUDGET_USD
require_env VERIFY_STALE_FORCE_OLLAMA_ONLY

OLLAMA_MODEL="${OLLAMA_MODEL:-nemotron-3-nano:4b}"
OLLAMA_URL="${OLLAMA_URL:-http://host.openshell.internal:11434}"
OPENCLAW_AGENT_CMD="${OPENCLAW_AGENT_CMD:-openclaw agent --local --timeout 3600}"
DOGFOOD_GIST_VISIBILITY="${DOGFOOD_GIST_VISIBILITY:-secret}"
DOGFOOD_BREV_HOURLY_USD="${DOGFOOD_BREV_HOURLY_USD:-3}"

[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] \
  || warn "NEMOCLAW_NON_INTERACTIVE is not '1' — interactive prompts may stall the run."

# -----------------------------------------------------------------------------
# Phase 2 — CLI install (gh, brev, jq, openclaw if missing)
# -----------------------------------------------------------------------------

info "Phase 2 — CLI install"

install_jq() {
  apt-get update -y >/dev/null 2>&1 && apt-get install -y jq >/dev/null 2>&1 \
    || fail "failed to install jq via apt; sandbox base image may need updating."
}

install_gh() {
  # Official GitHub CLI install per https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y >/dev/null 2>&1
  apt-get install -y gh >/dev/null 2>&1 \
    || fail "failed to install gh via apt."
}

install_brev() {
  # Brev CLI install (one-shot script from brevdev).
  curl -fsSL https://raw.githubusercontent.com/brevdev/brev-cli/main/install.sh \
    | bash >/dev/null 2>&1 \
    || fail "failed to install brev CLI."
  # The installer drops the binary into /root/.local/bin or similar — make sure
  # it's on PATH for the rest of this script and any child agent processes.
  export PATH="$HOME/.local/bin:$PATH"
}

command -v jq >/dev/null 2>&1 || { info "  installing jq..."; install_jq; }
command -v gh >/dev/null 2>&1 || { info "  installing gh..."; install_gh; }
command -v brev >/dev/null 2>&1 || { info "  installing brev..."; install_brev; }
command -v openclaw >/dev/null 2>&1 || fail "openclaw not in PATH — the maintainer sandbox image is missing OpenClaw."

info "  jq, gh, brev, openclaw all callable."

# -----------------------------------------------------------------------------
# Phase 3 — token + reachability check (also delegated to dogfood-preflight per
# candidate, but the orchestrator does a one-shot gate so we fail fast).
# -----------------------------------------------------------------------------

info "Phase 3 — token + reachability"

gh auth status >/dev/null 2>&1 || fail "gh auth status failed; GH_TOKEN missing/invalid."

GH_SCOPES=$(gh auth status 2>&1 | grep -oE "Token scopes: .*" || true)
case "$GH_SCOPES" in
  *repo*) ;;
  *) fail "GH_TOKEN missing 'repo' scope — label and comment writes will fail. Got: $GH_SCOPES" ;;
esac
case "$GH_SCOPES" in
  *project*) info "  gh has project scope (Project 199 moves enabled)." ;;
  *) warn "  gh missing 'project' scope — Project 199 moves will warn-and-skip. Run 'gh auth refresh -h github.com -s project' in a real TTY to add it." ;;
esac

brev ls >/dev/null 2>&1 \
  || fail "brev ls failed; BREV_API_TOKEN invalid or the brev policy preset isn't allowing egress."

# Ollama reachability + model presence.
if ! curl -sf -m 5 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  fail "Ollama not reachable at $OLLAMA_URL. Confirm ollama is running on the host AND the local-inference policy preset is selected."
fi
if ! curl -sf -m 5 "$OLLAMA_URL/api/tags" \
   | jq -e --arg m "$OLLAMA_MODEL" '.models[] | select(.name == $m or .name == ($m + ":latest"))' >/dev/null; then
  warn "Ollama model '$OLLAMA_MODEL' not loaded on host. Run: ollama pull $OLLAMA_MODEL"
  fail "missing model on host"
fi

info "  gh, brev, ollama-model all reachable."

# -----------------------------------------------------------------------------
# Phase 4 — log dir + skill workspace install
# -----------------------------------------------------------------------------

info "Phase 4 — log dir + skill workspace"

mkdir -p "$VERIFY_STALE_LOG_DIR"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$VERIFY_STALE_LOG_DIR/$RUN_ID"
mkdir -p "$RUN_DIR"
ln -sfn "$RUN_DIR" "$VERIFY_STALE_LOG_DIR/latest"
echo 0 > "$VERIFY_STALE_LOG_DIR/.spent-usd"

# Snapshot config for the run.
jq -n \
  --arg run_id "$RUN_ID" \
  --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg auto "$VERIFY_STALE_AUTO_APPROVE" \
  --arg dry "$VERIFY_STALE_DRY_RUN" \
  --argjson cap "$VERIFY_STALE_BATCH_CAP" \
  --arg log_dir "$VERIFY_STALE_LOG_DIR" \
  --argjson budget "$BREV_BUDGET_USD" \
  --arg ollama_only "$VERIFY_STALE_FORCE_OLLAMA_ONLY" \
  --arg model "$OLLAMA_MODEL" \
  '{run_id: $run_id, started_at: $started, auto_approve: $auto, dry_run: $dry,
    batch_cap: $cap, log_dir: $log_dir, budget_usd: $budget,
    force_ollama_only: $ollama_only, ollama_model: $model}' \
  > "$RUN_DIR/run-config.json"

# Symlink the skill into the agent's per-workspace skills dir so
# `openclaw agent` auto-loads it. The agent looks at <workspace>/skills (per
# node_modules/openclaw/docs/tools/agent-send.md and skills.md).
WORKSPACE_SKILLS="${OPENCLAW_WORKSPACE:-/sandbox/.openclaw/workspace}/skills"
SKILL_SRC="$(dirname "$(readlink -f "$0")")/../.agents/skills/nemoclaw-maintainer-verify-stale"
if [ ! -d "$SKILL_SRC" ]; then
  fail "skill source not found at $SKILL_SRC — orchestrator must run from a NemoClaw checkout."
fi
mkdir -p "$WORKSPACE_SKILLS"
ln -sfn "$SKILL_SRC" "$WORKSPACE_SKILLS/nemoclaw-maintainer-verify-stale"
info "  skill symlinked at $WORKSPACE_SKILLS/nemoclaw-maintainer-verify-stale"

# -----------------------------------------------------------------------------
# Phase 5 — candidate selection (agent does Step 1+3+4, prints JSON list)
# -----------------------------------------------------------------------------

info "Phase 5 — candidate selection (max $VERIFY_STALE_BATCH_CAP)"

LIST_PROMPT=$(cat <<EOF
Load the nemoclaw-maintainer-verify-stale skill. Execute Step 1 (select
candidates), Step 3 (filter), and Step 4 (parse reported version) ONLY —
do not proceed to Step 5+. Honor:
  VERIFY_STALE_BATCH_CAP=$VERIFY_STALE_BATCH_CAP
  VERIFY_STALE_FORCE_OLLAMA_ONLY=$VERIFY_STALE_FORCE_OLLAMA_ONLY
Output a JSON array on its own line with this exact shape, and nothing else:
  [{"issue": <int>, "reported_version": "v0.0.X"}, ...]
EOF
)

# Capture stdout to a file so we can grep the JSON line.
$OPENCLAW_AGENT_CMD --json --message "$LIST_PROMPT" > "$RUN_DIR/candidates.raw" 2>&1 \
  || warn "candidate-selection agent returned non-zero; trying to parse output anyway"

# Extract the JSON array. The agent's --json output wraps text; find the array.
CANDIDATES=$(python3 -c "
import json, re, sys
text = open('$RUN_DIR/candidates.raw').read()
# Try direct parse first (in case --json gave us clean structure).
try:
    obj = json.loads(text)
    if isinstance(obj, dict) and 'reply' in obj:
        text = obj['reply']
except Exception:
    pass
m = re.search(r'\[\s*\{[^\]]*\}\s*\]', text, re.DOTALL)
if not m:
    print('[]'); sys.exit(0)
try:
    arr = json.loads(m.group(0))
    print(json.dumps(arr))
except Exception:
    print('[]')
")

CANDIDATE_COUNT=$(echo "$CANDIDATES" | jq 'length')
if [ "$CANDIDATE_COUNT" -eq 0 ]; then
  warn "no candidates found — see $RUN_DIR/candidates.raw for the agent output."
  fail "empty candidate set; aborting before any cost."
fi

info "  candidates: $CANDIDATE_COUNT — $(echo "$CANDIDATES" | jq -r 'map("#" + (.issue | tostring)) | join(" ")')"
echo "$CANDIDATES" > "$RUN_DIR/candidates.json"

# -----------------------------------------------------------------------------
# Phase 6 — per-candidate verification loop with preflight + budget check
# -----------------------------------------------------------------------------

info "Phase 6 — verification loop"

PREFLIGHT="$(dirname "$(readlink -f "$0")")/dogfood-preflight.sh"

echo "$CANDIDATES" | jq -c '.[]' | while IFS= read -r candidate; do
  issue=$(echo "$candidate" | jq -r '.issue')
  reported=$(echo "$candidate" | jq -r '.reported_version // ""')

  # Budget gate BEFORE preflight (cheaper to skip early).
  spent=$(cat "$VERIFY_STALE_LOG_DIR/.spent-usd")
  if [ "$spent" -ge "$BREV_BUDGET_USD" ]; then
    warn "  budget exceeded ($spent / $BREV_BUDGET_USD USD) — halting at #$issue"
    break
  fi

  info "  → #$issue (reported $reported, spent so far: \$$spent / \$$BREV_BUDGET_USD)"

  # Deterministic preflight. Exit 1 = SKIP; exit 0 = PROCEED/PROCEED-WITH-CAVEATS.
  if ! "$PREFLIGHT" "$issue" "$reported"; then
    warn "    preflight SKIP for #$issue — see $RUN_DIR/$issue/preflight.json"
    continue
  fi

  # Single-issue agent invocation. Skill runs Steps 5-12 for this one issue.
  PROMPT=$(cat <<EOF
Load the nemoclaw-maintainer-verify-stale skill. Run single-issue mode on
issue #$issue (reported version: $reported). Honor the env vars set by the
operator: VERIFY_STALE_AUTO_APPROVE=$VERIFY_STALE_AUTO_APPROVE,
VERIFY_STALE_DRY_RUN=$VERIFY_STALE_DRY_RUN,
VERIFY_STALE_LOG_DIR=$VERIFY_STALE_LOG_DIR (per-issue artifacts go to
$RUN_DIR/$issue/). The deterministic preflight in
$VERIFY_STALE_LOG_DIR/$issue/preflight.json has already issued a PROCEED verdict; do NOT
re-run the deterministic checks — focus on the LLM-judgment ones
(reproducer-extractable, bug-class, tool-drift) per
reference/self-check.md. On completion, write a one-line entry to
$RUN_DIR/activity.md summarizing the verdict.
EOF
  )

  # Snapshot pre-candidate Brev state so the wrap-up can compare. We don't
  # gate on it (sweep happens at Phase 7), but it surfaces stragglers left
  # behind by previous candidates in the per-candidate log.
  #
  # `brev ls --json` is NOT a real CLI flag; the documented piped behavior
  # is one instance name per line. Filter for our verify-stale- prefix and
  # save as a newline-separated list (the wrap-up's diff is line-based).
  brev ls 2>/dev/null | grep '^verify-stale-' \
    > "$RUN_DIR/$issue/brev-pre.txt" 2>/dev/null \
    || : > "$RUN_DIR/$issue/brev-pre.txt"

  candidate_start_epoch=$(date +%s)
  set +e
  $OPENCLAW_AGENT_CMD --json --message "$PROMPT" > "$RUN_DIR/$issue/agent.log" 2>&1
  agent_rc=$?
  set -e
  candidate_end_epoch=$(date +%s)
  wallclock_sec=$((candidate_end_epoch - candidate_start_epoch))

  # Orchestrator-owned cost calc: wallclock × conservative hourly rate.
  # This is independent of whether the skill emits cost in metadata.json
  # (it currently doesn't), and is conservative-by-design — the operator
  # tunes DOGFOOD_BREV_HOURLY_USD to over-estimate the actual SKU.
  candidate_cost=$(awk -v sec="$wallclock_sec" -v rate="$DOGFOOD_BREV_HOURLY_USD" \
    'BEGIN { printf "%d", (sec/3600.0)*rate + 0.999 }')  # ceil
  new_spent=$((spent + candidate_cost))
  echo "$new_spent" > "$VERIFY_STALE_LOG_DIR/.spent-usd"

  # Persist per-candidate cost + timing so the run-summary aggregator picks
  # it up. We write to a sibling cost.json (not metadata.json) so we don't
  # clobber anything the skill writes.
  brev ls 2>/dev/null | grep '^verify-stale-' \
    > "$RUN_DIR/$issue/brev-post.txt" 2>/dev/null \
    || : > "$RUN_DIR/$issue/brev-post.txt"

  # `date -u -r <epoch>` is BSD/macOS syntax; `date -u -d @<epoch>` is GNU.
  # The sandbox runs Linux (GNU) but a maintainer might smoke-test on a mac,
  # so try BSD first and fall back. Matches the preflight script's pattern.
  fmt_epoch() {
    date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
  }
  candidate_start_iso=$(fmt_epoch "$candidate_start_epoch")
  candidate_end_iso=$(fmt_epoch "$candidate_end_epoch")

  jq -n \
    --argjson sec "$wallclock_sec" \
    --argjson cost "$candidate_cost" \
    --argjson rate "$DOGFOOD_BREV_HOURLY_USD" \
    --argjson rc "$agent_rc" \
    --arg start "$candidate_start_iso" \
    --arg end "$candidate_end_iso" \
    '{wallclock_sec: $sec, cost_usd: $cost, hourly_rate_usd: $rate,
      agent_exit: $rc, started_at: $start, ended_at: $end,
      cost_method: "wallclock × hourly_rate (conservative; not actual brev billing)"}' \
    > "$RUN_DIR/$issue/cost.json"

  info "    completed in ${wallclock_sec}s, cost +\$$candidate_cost (cumulative \$$new_spent / \$$BREV_BUDGET_USD)"

  if [ "$agent_rc" -ne 0 ]; then
    warn "    agent exit $agent_rc on #$issue — see $RUN_DIR/$issue/agent.log"
  fi
done

# -----------------------------------------------------------------------------
# Phase 7 — straggler sweep
# -----------------------------------------------------------------------------

info "Phase 7 — straggler sweep"

# `brev ls --json` is not a real flag; the documented piped output is one
# instance name per line. Filter for the skill's verify-stale- prefix.
stragglers=$(brev ls 2>/dev/null | grep '^verify-stale-' || true)

if [ -n "$stragglers" ]; then
  warn "  found stragglers:"
  printf '%s\n' "$stragglers" | sed 's/^/    - /' >&2
  while IFS= read -r box; do
    if [ -z "$box" ]; then continue; fi
    info "    brev delete $box"
    brev delete "$box" >/dev/null 2>&1 || warn "      failed to delete $box (manual cleanup needed)"
  done <<<"$stragglers"
else
  info "  none"
fi

# -----------------------------------------------------------------------------
# Phase 8 — aggregate run-summary.json
# -----------------------------------------------------------------------------

info "Phase 8 — run-summary.json"

SUMMARY="$RUN_DIR/run-summary.json"
SPENT_FILE="$VERIFY_STALE_LOG_DIR/.spent-usd"
python3 - "$RUN_DIR" "$SUMMARY" "$SPENT_FILE" <<'PY'
import json, os, sys, glob
run_dir, out_path, spent_file = sys.argv[1], sys.argv[2], sys.argv[3]
issues = []
for issue_dir in sorted(glob.glob(os.path.join(run_dir, "[0-9]*"))):
    issue_num = os.path.basename(issue_dir)
    rec = {"issue": f"#{issue_num}"}
    for f, key in [("metadata.json", "metadata"),
                   ("preflight.json", "preflight"),
                   ("self-check.json", "self_check"),
                   ("score.json", "score"),
                   ("cost.json", "cost")]:
        p = os.path.join(issue_dir, f)
        if os.path.exists(p):
            try:
                rec[key] = json.load(open(p))
            except Exception as e:
                rec[key] = {"_parse_error": str(e)}
    issues.append(rec)

verdicts = {}
costs = []
for r in issues:
    v = (r.get("score") or {}).get("verdict") \
        or (r.get("preflight") or {}).get("verdict") \
        or "unknown"
    verdicts[v] = verdicts.get(v, 0) + 1
    c = (r.get("cost") or {}).get("cost_usd")
    if c is not None:
        costs.append(c)

try:
    with open(spent_file) as f:
        spent_str = f.read().strip()
    spent = int(spent_str) if spent_str.isdigit() else None
except FileNotFoundError:
    spent = None

summary = {
    "run_dir": run_dir,
    "candidate_count": len(issues),
    "verdict_histogram": verdicts,
    "total_cost_usd": spent,
    "per_candidate_cost_usd": costs,
    "cost_method": "wallclock × DOGFOOD_BREV_HOURLY_USD (orchestrator-owned, conservative)",
    "issues": issues,
}
json.dump(summary, open(out_path, "w"), indent=2)
print(f"wrote {out_path}")
PY

jq '{candidate_count, verdict_histogram, total_cost_usd}' "$SUMMARY"

# -----------------------------------------------------------------------------
# Phase 9 — wrap-up Gist
# -----------------------------------------------------------------------------

info "Phase 9 — wrap-up Gist (visibility: $DOGFOOD_GIST_VISIBILITY)"

GIST_FLAGS=()
if [ "$DOGFOOD_GIST_VISIBILITY" = "public" ]; then
  GIST_FLAGS+=("--public")
fi

GIST_ARGS=("$RUN_DIR/run-config.json" "$RUN_DIR/run-summary.json" "$RUN_DIR/candidates.json")
if [ -f "$RUN_DIR/activity.md" ]; then
  GIST_ARGS+=("$RUN_DIR/activity.md")
fi

GIST_URL=$(gh gist create "${GIST_FLAGS[@]}" \
  --desc "verify-stale dogfood run $RUN_ID (dry_run=$VERIFY_STALE_DRY_RUN, cap=$VERIFY_STALE_BATCH_CAP)" \
  "${GIST_ARGS[@]}" 2>&1 \
  | grep -oE 'https://gist.github.com/[^[:space:]]+' || true)

if [ -n "$GIST_URL" ]; then
  info "  Wrap-up Gist: $GIST_URL"
  echo "$GIST_URL" > "$RUN_DIR/gist-url.txt"
else
  warn "  Gist creation failed — full run artifacts remain at $RUN_DIR on the persistent volume."
fi

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------

info "Done. Review $RUN_DIR/run-summary.json (or the wrap-up Gist) for results."
if [ "$VERIFY_STALE_DRY_RUN" = "1" ]; then
  info "If the drafts look right, re-run with VERIFY_STALE_DRY_RUN=0 for the live pass."
fi
