---
name: nemoclaw-maintainer-verify-stale
description: Verify whether old NVIDIA/NemoClaw bug reports still reproduce against the latest release. Picks candidate issues opened against older versions, reuses or provisions a Brev Linux box (CPU or GPU), attempts reproduction, scores confidence, and posts an evidence-backed comment with a label (fixed-on-latest or verify-inconclusive). Tag-only — never auto-closes. Linux-only in v1; Windows, macOS, and integration-token-dependent issues are skipped. Trigger keywords - verify stale, verify fixed, reproduce on latest, stale issue, old bug, fixed-on-latest, verify-inconclusive, drain backlog, brev verify.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Verify Stale Issues

Automates the manual loop of "spin up a Brev box, install latest NemoClaw, try to reproduce an old bug, comment with findings." Drains the bug backlog by surfacing issues that have been silently fixed.

This skill is the outbound counterpart to `nemoclaw-diagnosis` (which files issues from CI failures). Diagnosis fills the queue; this drains it.

---

## Step 1: Determine Mode

**Single-issue mode** — user provides an issue number:

```bash
gh issue view <number> --repo NVIDIA/NemoClaw \
  --json number,title,body,labels,url,author,createdAt,comments
```

**Batch mode** — user says "batch", "weekly", or provides no number. Cap at 20 issues per run.

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --limit 100 \
  --label bug \
  --json number,title,body,labels,url,author,createdAt,comments
```

In batch mode, work through items one at a time. Present each verification plan and wait for approval before any Brev provisioning.

---

## Step 2: Detect the Latest NemoClaw Version

Try GitHub releases first; fall back to the highest semver git tag if no release is published. NemoClaw currently tags but does not publish releases, so the fallback is the load-bearing path today.

```bash
LATEST=$(gh release view --repo NVIDIA/NemoClaw --json tagName -q .tagName 2>/dev/null)

if [ -z "$LATEST" ]; then
  LATEST=$(git ls-remote --tags --refs git@github.com:NVIDIA/NemoClaw.git \
    | awk -F/ '{print $NF}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | tail -1)
fi

echo "Latest release: $LATEST"
```

This is the version the skill will verify against. Record it — every comment must cite it.

---

## Step 3: Filter Candidates

Apply these rules in order. Drop any issue that fails a rule.

**Issue-type allowlist:** must have `bug` label.
**Issue-type skip:** drop if any of `enhancement`, `documentation`, `wontfix`, `needs-info`, `security`.

**Platform skip (Linux-only in v1):** drop if any of `Platform: Windows/WSL`, `Platform: MacOS`, `Platform: macOS`. Keep `Platform: Ubuntu`, `Platform: DGX Spark`, `Platform: GB10`, `Platform: All`, or no platform label.

**Integration skip (deferred to v2):** drop if any of `Integration: Slack`, `Integration: Discord`, `Integration: Telegram`, `Integration: Hermes`, `Integration: OpenClaw`, `Integration: WeChat`. These need third-party credentials a fresh Brev box cannot provide.

**Component allowlist (must have at least one):** `NemoClaw CLI`, `Sandbox`, `OpenShell`, `Docker`, `Getting Started`, or any `Platform:` label that survived the platform skip.

**Idempotency:** drop if **either** of these is true:

- The issue carries a `fixed-on-latest` or `verify-inconclusive` label. (Cleared by the release sweep in `nemoclaw-maintainer-cut-release-tag` so the issue re-opens on each release.)
- A `<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->` comment was posted **within the last 7 days**. The marker carries a date so the candidate filter can apply a TTL — useful for the still-reproduces case (Step 9), where no label is applied and we want next week's run to re-verify rather than skip forever.

**Candidate rule:** keep the issue if **either**:

- The reported version (parsed from body or labels — see Step 4) is **at least 2 versions behind** `$LATEST` in the rightmost-incrementing component, **or**
- The issue is **older than 7 days** AND a specific version is parseable from its body or labels.

For NemoClaw's current `0.0.x` line, "rightmost-incrementing component" is the patch number — a v0.0.31 report against a v0.0.34 latest is 3 versions behind. Once NemoClaw moves to `0.1.x` or higher, the rule applies to the next-rightmost component instead. Pick whichever component is actively iterating.

---

## Step 4: Parse Reported Version

The regex is intentionally **release-line agnostic**. Today NemoClaw ships `v0.0.x`, but the same parser must keep working when it moves to `v0.1.x`, `v1.x.x`, or anything else. Don't hardcode the major/minor digits.

Sources, in order of trust:

1. **Labels.** Any label that exactly matches `^v\d+\.\d+\.\d+$` AND appears in the repo's tag list. Labels matching the regex but absent from tags (e.g. `v0.0.35` as a *release-target* milestone before that version ships) are roadmap markers, not "reported on" — drop them.
2. **Body.** Use a **proximity-anchored** regex: `(?i)nemoclaw[^a-z\n]{0,80}v?(\d+\.\d+\.\d+)`. This matches a version that follows `nemoclaw` within 80 non-letter, non-newline characters, capturing just the semver. The anchoring is load-bearing — without it the parser also picks up `openshell 0.0.4`, Node.js `v22.16.0`, IP addresses (`0.0.0.0:11434`, `127.0.0.1`), and other near-NemoClaw products that happen to share the `v0.0.x` line. (This was confirmed in the dry-run: a non-anchored parser produced 12 false-positive candidates whose smallest tag-valid version was actually OpenShell's, not NemoClaw's.)
3. **Comments by the original reporter** — same anchored regex as the body.

Collect every match from sources 2 and 3 (a single body may mention multiple versions — `0.0.6 and v0.0.10`). Then validate.

**Validate against the tag list.** A parsed version must exist as a real git tag, otherwise drop it. This single check kills four classes of error in one pass:

- Reporter typos that cite a non-existent version (`v0.1.0` when only `v0.0.x` is released — observed 3× in the live backlog).
- Calver mistakes (`2026.3.11` — observed 1×).
- Future roadmap labels that slipped past source 1.
- Versions parsed from prose that happen to look semver-ish but aren't releases.

```bash
git ls-remote --tags --refs git@github.com:NVIDIA/NemoClaw.git \
  | awk -F/ '{print $NF}' > /tmp/nemoclaw-tags.txt

# For each candidate version V:
grep -Fxq "$V" /tmp/nemoclaw-tags.txt || drop_version "$V"
```

After validation, **pick the smallest surviving version** as the reported version (most conservative — it maximizes versions-behind). This handles "this bug was first reported on v0.0.6 and still happens on v0.0.10" cleanly: we verify against latest, and if the bug is gone, both reports are addressed.

If no version survives, drop the issue from the candidate set — we cannot establish "previous version".

**Variable format for downstream steps.** Set `REPORTED_VERSION` to the **full tag string** (e.g., `REPORTED_VERSION="v0.0.32"`), not just the patch number. Step 8a's installer expects the full tag via the `NEMOCLAW_INSTALL_TAG` env var.

### Implementer note: regex-pipeline pitfalls

Two real failure modes surfaced during the v1 dry-run. Test both before trusting your implementation:

1. **Empty-match handling.** A naive pipeline like `[scan(regex)] | first | .[0] | tonumber // fallback` silently dropped 9 real candidates (e.g. #2861 with `NemoClaw 0.0.32`, #2604 with `NemoClaw: 0.0.28`). When `scan` returns no matches, `[]` flows in, `first` returns null, `null | .[0]` errors, and `//` does not propagate cleanly through the error. Bind each pass to a named variable, coalesce at the end:

   ```text
   primary  := first nemoclaw-anchored match in body  (or null)
   result   := primary ?? null
   ```

   Then explicitly test against a body with **no** version mention.

2. **Capture-group consistency.** A regex without a capture group (e.g. `\bv\d+\.\d+\.\d+\b`) makes `scan` emit raw strings; with a capture group (e.g. `\b(v\d+\.\d+\.\d+)\b`), `scan` emits arrays. Mixing the two within one pipeline (`first | .[0]?`) works for one and silently fails for the other. Use capture groups consistently across all branches.

3. **Variable scoping in `select(...)`.** A line like `select($tags | index(.))` rebinds `.` to `$tags` inside the parens, so `.` no longer refers to the surrounding label being checked. Bind first: `. as $lbl | select($tags | any(. == $lbl))`. Symptom in this dry-run: the future-release label `v0.0.35` passed validation that should have rejected it.

---

## Step 5: Classify the Verification Environment

**CPU vs GPU:** GPU if any of these signals are present, else CPU.

- Labels: `Platform: GB10`, `Platform: DGX Spark`.
- Body keywords: `cuda`, `nvidia-smi`, `inference`, `model serving`, `H100`, `A100`, `GB10`, `DGX`.

CPU default keeps cost low. Only escalate to GPU when the reproducer needs one.

---

## Step 6: Extract the Reproducer

Extract whatever's available from the issue body. The decision about *whether the reproducer is good enough* lives in Step 8 (validate-on-baseline), not here.

1. **Verbatim:** the first fenced code block (triple-backtick or `<pre>`) containing a `nemoclaw` invocation. Save to `./reproducer.sh`. No confidence penalty (yet).
2. **No verbatim block found:** leave `./reproducer.sh` absent. Step 8b will synthesize from the issue body on demand and apply the **−30 synth penalty** at that point.

The "give up immediately" path is gone. Synthesis happens at validation time so it has the baseline transcript to react to, not just the issue body in isolation. The give-up decision now lands in Step 8c when synth fails to produce a script that actually exposes the bug.

---

## Step 6.5: Verify Preconditions

Confirm `brev` is authenticated and the install URL resolves before paying any cost. Credentials live in `~/.brev/credentials.json` and are reused across shells under the same OS user, so once authenticated the auth check is a no-op until the token expires.

```bash
# Brev auth — short-circuit only after the auth check, not before.
brev ls --json >/dev/null 2>&1 || {
  echo "Brev not authenticated. Choose one:"
  echo "  1) brev login --skip-browser     # prints a URL, works from any shell"
  echo "  2) brev login                    # opens browser, run in a separate terminal if your shell lacks a TTY"
  echo "  3) brev login --token \"\$BREV_API_TOKEN\"  # non-interactive, same env var used by test/e2e/brev-e2e.test.ts"
  exit 1
}

# Install URL reachable — fails fast instead of mid-Brev-run if the host is down or the URL changed.
INSTALL_URL=${NEMOCLAW_INSTALL_URL:-https://nemoclaw.nvidia.com/install.sh}
curl -fsI "$INSTALL_URL" >/dev/null 2>&1 || {
  echo "ERROR: install URL not reachable: $INSTALL_URL"
  echo "Set NEMOCLAW_INSTALL_URL or check https://nemoclaw.nvidia.com is up."
  exit 1
}
```

If invoked from an environment without a TTY (some agent harnesses), prefer `brev login --skip-browser` or `--token` over the default browser flow.

---

## Step 6.7: Try Local Reproduction First

For pure-CLI reproducers (no sandbox state, no GPU, no integration tokens), try locally before paying for a Brev box. The evidence is identical — `nemoclaw <args>` on a maintainer laptop produces the same exit code and stdout as on a fresh Brev VM, modulo platform differences — and the run is free.

**Predicate** — local-first applies if **all** of these hold:

- Reproducer is a sequence of `nemoclaw <args>` invocations only. No `docker`, `kubectl`, `curl`, `npm`, networking setup, or filesystem fixtures.
- Issue has no `Sandbox`-only or `Docker` label and no GPU signal from Step 5.
- `which nemoclaw` resolves on the maintainer's machine and `nemoclaw --version` reports a build at or past `$LATEST` (a build between `$LATEST` and `$LATEST+main` is fine — these only differ by unmerged WIP).
- Maintainer is on Linux or macOS. Windows local repros are out of scope (per Step 3 platform skip rules).

**If the predicate fires:**

```bash
LOCAL_VERSION=$(nemoclaw --version 2>&1)
LOCAL_TRANSCRIPT=$(mktemp)
{ time bash reproducer.sh; } >"$LOCAL_TRANSCRIPT" 2>&1
LOCAL_EXIT=$?
echo "Local: $LOCAL_VERSION, exit $LOCAL_EXIT"
```

Compare local result to the issue's "Actual Result" section using the same match rubric Step 8b applies on baseline:

- **Local matches the issue symptom exactly** (same exit code + same diagnostic output) AND the symptom is the post-fix expected output → skip Brev. Use the local transcript as the verified-on-latest evidence. Step 10's comment must say `Environment: local install (<version>) — Brev provisioning skipped, outcome deterministic from CLI surface alone`.
- **Local result differs from the reported "Actual Result"** → continue to Step 7 and run on Brev. The local environment may be a confound (different OS, dirty config, partial build); remote confirms.
- **Local repro errors out for environmental reasons** (`nemoclaw: command not found`, npm link broken) → continue to Step 7. Treat as inconclusive locally, not a verification failure.

**If the predicate does not fire:** proceed to Step 7 normally. Most sandbox-touching bugs need Brev.

---

## Step 7: Reuse or Provision a Brev Box

The skill prefers reuse over provisioning. A pool of `verify-stale-*` boxes (CPU and GPU) can be kept warm; reuse the matching one if available, otherwise provision.

```bash
# Auth + install URL already verified by Step 6.5 — no need to re-check or auto-login here.

# Determine class from Step 5: "cpu" or "gpu"
INSTANCE_CLASS="cpu"   # or "gpu"

INSTANCES=$(brev ls --json)

# Look for an existing running verify-stale-* box matching the required class.
# CPU boxes have no .gpu field set; GPU boxes do.
EXISTING=$(echo "$INSTANCES" | jq -r --arg class "$INSTANCE_CLASS" '
  .[]?
  | select(.name | startswith("verify-stale-"))
  | select(.status == "RUNNING")
  | select(($class == "gpu" and (.gpu // "" != ""))
        or ($class == "cpu" and (.gpu // "" == "")))
  | .name' | head -1)

PROVISIONED_NEW=0

if [ -n "$EXISTING" ]; then
  INSTANCE_NAME="$EXISTING"
  echo "Reusing existing verification box: $INSTANCE_NAME"
else
  # Concurrency cap: refuse if 4+ verify-stale-* boxes are already running.
  RUNNING=$(echo "$INSTANCES" | jq '[.[]? | select(.name | startswith("verify-stale-"))] | length')
  if [ "$RUNNING" -ge 4 ]; then
    echo "ERROR: 4 verify-stale boxes already running. Wait for one to finish or reuse."
    exit 1
  fi

  INSTANCE_NAME="verify-stale-${ISSUE_NUMBER}-$(date +%s)"

  if [ "$INSTANCE_CLASS" = "gpu" ]; then
    # brev create auto-selects the cheapest GPU meeting the defaults
    # (>=20GB VRAM, >=500GB disk, compute >=8.0). Override with --type if needed.
    brev create "$INSTANCE_NAME"
  else
    # CPU case: pick the cheapest stoppable Linux SKU at runtime so the skill
    # doesn't rot when SKUs change. Override by exporting VERIFY_STALE_CPU_TYPE.
    CPU_TYPE=${VERIFY_STALE_CPU_TYPE:-$(brev search cpu --sort price --json \
      | jq -r '[.[] | select(.stoppable == true)] | .[0].type')}
    [ -n "$CPU_TYPE" ] || { echo "ERROR: no stoppable CPU SKU available"; exit 1; }
    brev create "$INSTANCE_NAME" --type "$CPU_TYPE"
  fi

  PROVISIONED_NEW=1
fi

# Cleanup runs on success, error, and SIGINT.
# Delete only what we provisioned. Reused boxes stay warm for next time.
# `brev delete` is non-interactive by default — there is no --yes flag, and passing one errors.
echo ">>> Brev instance: $INSTANCE_NAME (provisioned_new=$PROVISIONED_NEW; manual cleanup: brev delete $INSTANCE_NAME)"
trap '[ "$PROVISIONED_NEW" = "1" ] && brev delete "$INSTANCE_NAME" >/dev/null 2>&1 || true' EXIT
```

Wallclock cap per verification: **25 minutes** to accommodate two installs (reported version baseline + latest). If a provisioned box isn't ready in time, abort and treat as an infra failure (Step 11).

**Extended budget for time-sensitive bugs.** If the issue body contains keywords suggesting the bug only manifests over time (`after N minutes`, `after N requests`, `eventually`, `over time`, `memory leak`, `long-running`, `idle for`), bump the cap to **60 minutes**. Detection is simple keyword match. Hard ceiling at 60 min — bugs that genuinely require hours fall out of v1 scope.

---

## Step 8: Validate on Baseline, Verify on Latest

Two-pass design.

- **Baseline pass (8a–8c):** install the **reported version**, run the reproducer, confirm it actually exposes the bug as described. This is the gate that proves the script is real.
- **Latest pass (8d):** install **latest**, run the validated reproducer. This is what the confidence score is built on.

Without the baseline gate, a clean run on latest is ambiguous: maybe the bug really got fixed, maybe the script was never capable of triggering it. The baseline disambiguates.

### Comprehensive reset (run before each install)

NemoClaw spawns OpenShell sandboxes (containers), runtime services, and listening processes. A naive `rm -rf ~/.nemoclaw` doesn't clean those — the latest install would inherit baseline state and contaminate the result. Use this fuller reset between installs:

```bash
RESET=$(cat <<'SCRIPT'
nemoclaw destroy --all --force 2>/dev/null || true
pkill -9 -f nemoclaw 2>/dev/null || true
pkill -9 -f openshell 2>/dev/null || true
docker ps -a --filter "name=openshell-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
docker ps -a --filter "name=nemoclaw-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
rm -rf ~/.nemoclaw 2>/dev/null
sudo -n rm -f /usr/local/bin/nemoclaw 2>/dev/null || true
sudo -n rm -rf /usr/local/lib/nemoclaw 2>/dev/null || true
for port in 8080 18789 9119; do fuser -k -n tcp $port 2>/dev/null || true; done
true
SCRIPT
)
```

Idempotent — fails silently when there's nothing to clean. Run via `brev exec "$INSTANCE_NAME" "$RESET"` before 8a's install and again before 8d's install.

**Sudo precondition.** All `sudo` invocations use `sudo -n` (non-interactive) so they fail fast instead of hanging on a password prompt. The skill assumes the Brev image's default user has passwordless sudo configured — Brev's stock images do; custom images may not. If `sudo -n` fails, the binary cleanup is best-effort and a stale `/usr/local/bin/nemoclaw` may persist. The user-local install path (`~/.nemoclaw`) is fully reset regardless.

### Step 8a: Install reported version

The installer accepts the target ref via the `NEMOCLAW_INSTALL_TAG` env var (verified against `install.sh` source — defaults to `latest` if unset). It is **not** a `--version` flag.

```bash
brev exec "$INSTANCE_NAME" "$RESET"

brev exec "$INSTANCE_NAME" "NEMOCLAW_INSTALL_TAG=$REPORTED_VERSION bash -c 'curl -fsSL $INSTALL_URL | bash'" \
  || BASELINE_INSTALL_FAILED=1
brev exec "$INSTANCE_NAME" "nemoclaw --version"
```

If install fails (old releases rot — installer URLs, deps, OS images all drift over time), set `BASELINE_INSTALL_FAILED=1` and **skip 8b/8c**, going straight to 8d. Note "baseline-install-skipped" in the final comment. Step 9's scoring rule handles the degraded mode.

### Step 8b: Run reproducer on baseline, compare to issue symptom

If `./reproducer.sh` exists (verbatim from Step 6), run it. Otherwise synth on demand from the issue body (apply −30 penalty now, locked in for the rest of the run).

**Interactive subcommand handling.** Many `nemoclaw onboard` / `nemoclaw configure` invocations prompt for input and will hang in a non-interactive shell. Auto-detect such subcommands in the script and apply, in order:

1. Add `--non-interactive` if the version supports it.
2. Add `--dangerously-skip-prompts` (issue #2168 confirmed this exists for at least some Jetson paths).
3. Pre-feed answers via stdin: `printf 'yes\n\n\n' | nemoclaw onboard ...`

If none work, route the script to Step 8c (synth-repro) so the LLM can rewrite it using non-interactive equivalents.

```bash
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" "bash ~/reproducer.sh" 2>&1 | tee ./baseline-transcript.log
```

**Match rubric.** LLM compares `baseline-transcript.log` to the issue's "Actual result" / error description. Match criteria, in order:

1. **Exit code agrees** with what the issue describes (non-zero if issue describes a failure, zero if issue describes a wrong-output bug). Necessary but not sufficient.
2. **Symptom phrase match:** transcript contains a key error phrase from the issue (e.g., issue says `Permission denied on generate-openclaw-config.py`, transcript says `EACCES: permission denied, open '...generate-openclaw-config.py'` — semantic equivalence counts).
3. **Distinguish bug from infra noise:** generic network / DNS / auth errors don't count as a match unless the issue itself describes them. A bug about config parsing that fails at "could not resolve nvidia.com" is an infra failure, not a reproduction.

**Fallback for issues without an explicit "Actual result" section.** Many bug reports describe a *behavioral* problem rather than a runtime error — e.g., "should default to a stable released version" (#1242), "configuration is not persisted across rebuilds" (#3030). These have no comparable error string. In that case:

1. Use the issue's **full title + description** as the symptom signal.
2. Match if the reproducer's outcome **contradicts the issue's stated expected behavior** (or matches the stated wrong behavior). E.g., issue says "expected: stable release; actual: nightly", reproducer prints `nightly-build-2026.04.x` → that's a match.
3. If neither error string nor expected-behavior contradiction can be identified, route the script to Step 8c (synth-repro) — let the LLM produce a more diagnostic script that emits something testable.

- **Match** → reproducer validated. Proceed to 8d.
- **No match** (silent pass, wrong error, infra noise, or no testable outcome): script has gaps. Proceed to 8c.

### Step 8c: Synth-repro and retry on baseline

LLM rewrites `./reproducer.sh` using the full issue context (description, environment, symptoms) **plus the baseline transcript** so it can react to what actually happened. Apply **−30 confidence penalty** (or keep it if 8b already applied it for the missing-verbatim case).

```bash
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" "bash ~/reproducer.sh" 2>&1 | tee ./baseline-transcript-2.log
```

- **Match:** validated (with −30 baked in). Proceed to 8d.
- **Still no match:** mark `verify-inconclusive`. Post a comment that includes both reproducer attempts and both baseline transcripts with the message "couldn't establish a working reproducer for this bug on `$REPORTED_VERSION`." **Skip 8d** — there's nothing to verify on latest.

### Step 8d: Install latest, run validated reproducer

```bash
brev exec "$INSTANCE_NAME" "$RESET"
brev exec "$INSTANCE_NAME" "curl -fsSL $INSTALL_URL | bash"
brev exec "$INSTANCE_NAME" "nemoclaw --version"

brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" "bash ~/reproducer.sh" 2>&1 | tee ./latest-transcript.log
```

If the install of **latest** fails (e.g. installer regression — see #3058 for a current example), this is an infra failure — see Step 11. Do not score or label the issue.

If install succeeds, `latest-transcript.log` is the input to Step 9 scoring.

For interactive debugging when something looks off:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 9: Score Confidence

Start at 0. Apply each rule that fires.

| Signal | Delta |
|---|---|
| Reproducer ran cleanly on **latest** (8d), exit 0, no bug symptom observed | +50 |
| Commits between reported version and `$LATEST` touch the implicated component (see "Path extraction" below) | +25 |
| A merged PR mentions this issue number or its symptom (see "PR search" below) | +25 |
| Reproducer was LLM-synthesized at any point (Step 8b synth or Step 8c retry) | −30 |
| Any partial error, warning, or flaky behavior in the latest run (8d) | −50 |

Total is clamped to `[0, 100]`.

### Path extraction (for the +25 commits signal)

The skill needs to know *which* path to `git log v<reported>..$LATEST -- <path>` against. Apply in order, stop at the first that yields a non-empty path:

1. **Stack trace / file path mentions in the issue body.** Grep the body for absolute paths under known install roots, then map to repo paths:
   - `/usr/local/lib/nemoclaw/<rel>` → `<rel>` in repo (e.g., `scripts/generate-openclaw-config.py`)
   - `/usr/local/bin/nemoclaw*` → `bin/`
   - `~/.nemoclaw/<rel>` → most often runtime state, drop unless the bug is config-related → `src/lib/config/`
   - In-repo paths (e.g., `bin/lib/policies.js` mentioned literally) → use as-is
2. **Component-label-to-directory map.** Pick the first match:
   - `NemoClaw CLI` → `bin/`, `src/`
   - `Sandbox` → `src/lib/sandbox/`, `nemoclaw/sandbox/`
   - `OpenShell` → `nemoclaw/openshell/`, `src/lib/openshell/`
   - `Docker` → `Dockerfile`, `scripts/install-openshell.sh`
   - `Getting Started` → `docs/`, `install.sh`
   - `Integration: <X>` (when not in skip list) → `src/lib/integrations/<x>/`
3. **Title keywords.** "TUI" → `src/tui/`, "policy" → `src/lib/policy/`, "inference" → `src/lib/inference/`.

If none of the above produces a path, **skip the +25 signal entirely** rather than guessing. Floating the +25 on every issue would inflate scores meaninglessly.

### PR search (for the +25 PR signal)

```bash
# Direct issue-number reference (covers most cases — "fixes #2861" etc.)
DIRECT_REF=$(gh pr list --repo NVIDIA/NemoClaw --state merged \
  --search "$ISSUE_NUMBER" \
  --json number,title,mergedAt,body \
  -q "[.[] | select((.body + \" \" + .title) | test(\"#$ISSUE_NUMBER\\\\b\"))]")

# Symptom-phrase fallback (only if direct reference returns nothing)
if [ -z "$DIRECT_REF" ] || [ "$DIRECT_REF" = "[]" ]; then
  SYMPTOM=$(extract first key error/symptom phrase from issue body, ~3-6 words)
  SYMPTOM_REF=$(gh pr list --repo NVIDIA/NemoClaw --state merged \
    --search "\"$SYMPTOM\"" \
    --json number,title,mergedAt)
fi
```

Apply +25 if either query returns at least one PR with `mergedAt` strictly after the tag date of `$REPORTED_VERSION` (look up via `git log -1 --format=%cI v$REPORTED_VERSION`). PRs merged before the reporter even filed the issue can't have fixed it.

If neither query returns anything, **skip the +25 signal**.

**Baseline-validation gating.** The +50 weight assumes the reproducer was *validated* — i.e., it produced the bug symptom on baseline (Step 8b/8c match). If `BASELINE_INSTALL_FAILED=1` (Step 8a fall-through, baseline pass skipped), the +50 still applies but **cap the total at 84** unless commits-touched-area or merged-PR-mention also fires. Without baseline AND without corroborating evidence, the cleanest landing is the 60–84 band where the reporter is asked to confirm — we don't have enough on our own to claim ≥85.

**Action (when latest run was clean — bug not reproduced):**

| Score | Label | Comment |
|---|---|---|
| ≥85 | `fixed-on-latest` | Evidence-rich, no @-mention. |
| 60–84 | `fixed-on-latest` | Evidence-rich, **@-mention the original reporter** to confirm. |
| <60 | `verify-inconclusive` | Short, honest "couldn't verify" explanation. |

**Special case: latest output matches the issue symptom (bug still reproduces on latest).**

This is not a flake — the skill positively confirmed the bug is still live. Don't apply the +50 weight (the bug isn't fixed) and skip the score table entirely.

- Post a "still reproduces on latest" comment with both transcripts.
- Apply **no label**.
- Include the marker `<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->` with today's date so the candidate filter applies the 7-day TTL (Step 3 idempotency).
- Next weekly run picks the issue back up after the TTL — if the bug gets fixed in the meantime, that run catches it.

The skill **never closes issues** in any branch. A maintainer pulls that trigger after reviewing the label and comment.

---

## Step 10: Compose and Post the Comment

**Redaction pass before posting.** Run on **every** chunk of text quoted in the comment — issue body excerpts, baseline transcript, latest transcript, synth-repro scripts. Replace each match with `[REDACTED]`. The transcripts especially leak — they include full stdout/stderr from real installs and runs.

| Pattern | Targets |
|---|---|
| `(?i)(token\|secret\|password\|api[_-]?key\|bearer)[^\n]*[:=][^\n]*` | Inline credentials in env/config/log output |
| `(?i)authorization:\s*\S+` | HTTP auth headers (often Bearer + JWT) |
| `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` | JWT tokens |
| `gh[pousr]_[A-Za-z0-9]{36,}` | GitHub PATs / install tokens |
| `AKIA[0-9A-Z]{16}` | AWS access key IDs |
| `(?i)aws_secret_access_key\s*=\s*\S+` | AWS secret keys |
| `(?i)nvapi-[A-Za-z0-9_-]{20,}` | NVIDIA API keys (NIM / build.nvidia.com) |
| URLs containing `@` before the host (e.g., `https://user:pw@host/...`) | Basic-auth credentials in URLs |
| `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | Email addresses (PII) |
| `\b[A-Za-z0-9+/]{60,}={0,2}\b` | Long base64 blobs (likely keys/sessions; tune length to taste — too short hits legit data) |
| `\b\w+\.(nvidia\.internal\|nv-internal\.com\|nvidia\.dev)\b` | Internal hostnames (extend list per team) |

**File paths under the reporter's home directory** (`/Users/<name>/`, `/home/<name>/`) → replace with `~/`. Catches incidental username PII.

**Order matters.** Run the longest, most-specific patterns first (JWT, AWS, NVIDIA-API) before the generic base64 catchall, otherwise the catchall masks the specific match and you lose the fact that *what* was redacted was a JWT vs a session blob.

**Comment template (fixed / inconclusive — bug not reproduced on latest):**

````markdown
## Stale-issue verification — automated

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04 / <CUDA version if GPU>

### Baseline (reported version)

- Install: succeeded · skipped (install rotted)
- Reproducer: extracted verbatim · synthesized (−30 penalty)
- Result: bug symptom matched (validated) · could not validate (skipped Step 8c gate)

<details><summary>Baseline transcript</summary>

```text
<full baseline transcript>
```

</details>

### Latest

- Install: succeeded
- Result: not reproducible — clean run, no bug symptom observed

<details><summary>Latest transcript</summary>

```text
<full latest transcript>
```

</details>

### Verdict

**Confidence:** 88 / 100. Labelling `fixed-on-latest`.

<details><summary>Relevant changes since v0.0.31</summary>

- abc1234 — fix: <commit subject>
- def5678 — refactor: <commit subject>

</details>

If this verification is wrong, please reopen the issue with a comment and the skill will re-verify on the next release.

<!-- nemoclaw-verify-stale v1 2026-05-12 -->
````

**Comment template (still reproduces — Step 9 special case):**

````markdown
## Stale-issue verification — still reproducible

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04

The skill ran the reported reproducer on v0.0.34 and observed the same bug symptom described in this issue. The bug is still live.

No label applied. Will re-verify automatically next weekly run; if a fix lands in the interim, the next pass catches it.

<details><summary>Baseline transcript (validated reproducer)</summary>

```text
<baseline transcript>
```

</details>

<details><summary>Latest transcript (bug still observed)</summary>

```text
<latest transcript>
```

</details>

<!-- nemoclaw-verify-stale v1 2026-05-12 -->
````

The trailing HTML comment is the **idempotency marker** Step 3 looks for. Always include today's date in `YYYY-MM-DD` format so the candidate filter can apply the 7-day TTL.

**Post the comment and apply the label:**

```bash
gh issue comment "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --body-file comment.md
gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "fixed-on-latest"
# or for <60:
# gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "verify-inconclusive"
```

---

## Step 11: Infra Failure Handling

Two different failure types, two different responses.

**Latest-install failure** (Step 8d) or reuse-check / provisioning / harness errors: hard infra failure.

- Print the error.
- Apply **no label** — infra failures must not pollute the verification record.
- Post a short comment **only if explicitly requested by the invoking user**. Default is silent move-on.
- Continue to the next candidate in batch mode.

The next weekly run retries naturally.

**Baseline-install failure** (Step 8a, reported version won't install on a modern image): not a hard failure — degraded mode.

- Set `BASELINE_INSTALL_FAILED=1`, skip 8b/8c, jump to 8d.
- Step 9 applies the score cap (max 84) unless corroborating evidence fires.
- Note "baseline-install-skipped" in the final comment so a reviewer knows the verification ran without the script-validation gate.

This degradation is expected — old releases rot. We still want to extract whatever signal we can from the latest run plus PR/commit evidence, just at a more conservative confidence ceiling.

**Keep-box-on-inconclusive.** When `verify-inconclusive` lands (Step 8c gave up, or Step 9 score < 60), **delay the cleanup `brev delete` by 30 minutes** if the box was provisioned by this run. Print the `brev shell "$INSTANCE_NAME"` command in the run output so a maintainer can hop in and triage. Reused boxes stay regardless. Ship-failed verifications are the exact case where having an inspectable artifact pays for itself.

---

## Step 12: Log to Activity

After each issue (verified, inconclusive, or infra-failed), append to `~/development/daily-rhythm/activity/nemoclaw-verify-stale-log.md`.

```markdown
### NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Environment:** CPU | GPU (<instance type>)
**Box:** reused <name> | provisioned <name>
**Baseline install:** succeeded | failed (degraded mode)
**Baseline match:** validated (verbatim) | validated (synth) | failed (verify-inconclusive) | skipped
**Latest install:** succeeded | failed (infra error)
**Latest result:** not-reproduced (clean) | still-reproduces | partial / flake | n/a (skipped 8d)
**Confidence:** 88 / 100 | n/a (still-reproduces)
**Label applied:** fixed-on-latest | verify-inconclusive | none (still-reproduces) | none (infra)
**Brev wall time (approx):** N min

---
```

Create the file if missing, with this header:

```markdown
# NemoClaw — Verify Stale Log

A running record of stale-issue verification runs on NVIDIA/NemoClaw.
Persisted via daily-rhythm to GitLab.

---
```

At end of a batch session, prepend a session summary:

```markdown
## YYYY-MM-DD — Verify Session
**Issues considered:** N
**Verified `fixed-on-latest`:** N
**Marked `verify-inconclusive`:** N
**Skipped (Windows / macOS / integration / no version):** N
**Infra failures:** N
**Brev wall time:** N min · approx $X.XX

---
```

Never stage or commit the log to the NemoClaw repo.

---

## Cadence

- **Weekly cron** — Monday morning, batch mode, ≤20 issues.
- **Manual** — invoke with a single issue number anytime.

---

## Out of Scope (v1)

- Auto-closing issues. Always tag-only; a human pulls the trigger.
- macOS verification. Brev offers no macOS instances and local-laptop runs are not unattended.
- Issues requiring third-party integration credentials (Slack, Discord, Telegram, Hermes, OpenClaw, WeChat).
- Service-account bot identity. v1 runs under each maintainer's own GitHub credentials.
- Versioned labels. A single `fixed-on-latest` label is swept on each release cut.

---

## Companion Behavior

`nemoclaw-maintainer-cut-release-tag` sweeps `fixed-on-latest` and `verify-inconclusive` from all open issues at release time. Without that sweep, "latest" drifts and verifications go stale silently.
