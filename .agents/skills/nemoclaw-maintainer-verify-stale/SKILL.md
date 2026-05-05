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

**Idempotency:** drop if any comment body on the issue contains `<!-- nemoclaw-verify-stale v1 -->`. The skill never re-verifies an issue within the same release window. (The release sweep in `nemoclaw-maintainer-cut-release-tag` clears prior `fixed-on-latest` and `verify-inconclusive` labels on each release, which is what re-opens the candidate set.)

**Candidate rule:** keep the issue if **either**:

- The reported version (parsed from body or labels — see Step 4) is **at least 2 versions behind** `$LATEST` in the rightmost-incrementing component, **or**
- The issue is **older than 7 days** AND a specific version is parseable from its body or labels.

For NemoClaw's current `0.0.x` line, "rightmost-incrementing component" is the patch number — a v0.0.31 report against a v0.0.34 latest is 3 versions behind. Once NemoClaw moves to `0.1.x` or higher, the rule applies to the next-rightmost component instead. Pick whichever component is actively iterating.

---

## Step 4: Parse Reported Version

The regex is intentionally **release-line agnostic**. Today NemoClaw ships `v0.0.x`, but the same parser must keep working when it moves to `v0.1.x`, `v1.x.x`, or anything else. Don't hardcode the major/minor digits.

Sources, in order of trust:

1. A label that exactly matches a real released version (e.g. `v0.0.32`). Reject labels that match a version newer than `$LATEST` — those are roadmap/release-target labels, not "reported on".
2. The body. Two-pass regex:
   - **Primary:** `\bv\d+\.\d+\.\d+\b` — require the `v` prefix and word boundaries. Matches any `vMAJOR.MINOR.PATCH`.
   - **Fallback:** `\b\d+\.\d+\.\d+\b` **only on lines containing `nemoclaw` or `version` (case-insensitive)**. Without that line filter, the fallback alone matches IPs and bind addresses (`0.0.0.0:11434`, `127.0.0.1`) and other unrelated semver-ish strings, producing phantom candidates.
3. Comments by the original reporter (same two-pass regex as the body).

After parsing, run two validation passes:

- **Clamp future:** if the parsed version is greater than `$LATEST`, treat it as unparseable. This catches roadmap labels that slipped past source 1.
- **Validate against tags:** confirm the parsed version exists as an actual git tag. This catches reporter typos such as `NemoClaw: v0.1.0` (no such release in the current `v0.0.x` line) and calver mistakes like `NemoClaw: 2026.3.11` (date string, not a tag).

```bash
git ls-remote --tags --refs git@github.com:NVIDIA/NemoClaw.git \
  | awk -F/ '{print $NF}' \
  | grep -Fx "v$PARSED_VERSION" >/dev/null \
  || PARSED_VERSION=""   # treat as unparseable
```

If no version survives both passes, drop the issue from the candidate set — we cannot establish "previous version".

### Implementer note: regex-pipeline pitfall

In the v1 dry-run, a naive jq pipeline that chained the primary and fallback regexes via `[scan(primary)] | first | .[0] | tonumber // [scan(fallback)] | first | .[0] | tonumber` silently dropped 9 real candidates (e.g. #2861 with `NemoClaw 0.0.32` in body, #2604 with `NemoClaw: 0.0.28`). When the primary regex matched empty, `null | first` errored, and `//` did not propagate cleanly to the fallback.

Whichever language you implement in, structure the parser so the empty-match path returns null cleanly (not an error). Bind each pass to a named variable and `coalesce` them at the end:

```text
primary  := first match of \bv\d+\.\d+\.\d+\b in body  (or null)
fallback := first match of \b\d+\.\d+\.\d+\b on nemoclaw/version lines  (or null)
result   := primary ?? fallback
```

Always test against an issue body with **no** version mention before trusting the result — that's the path that exercises the empty-match handling.

---

## Step 5: Classify the Verification Environment

**CPU vs GPU:** GPU if any of these signals are present, else CPU.

- Labels: `Platform: GB10`, `Platform: DGX Spark`.
- Body keywords: `cuda`, `nvidia-smi`, `inference`, `model serving`, `H100`, `A100`, `GB10`, `DGX`.

CPU default keeps cost low. Only escalate to GPU when the reproducer needs one.

---

## Step 6: Extract the Reproducer

Try in order, stop at the first that works:

1. **Verbatim extraction:** the first fenced code block in the issue body that contains a `nemoclaw` invocation. No confidence penalty.
2. **LLM synthesis:** if no fenced block matches, synthesize a shell script from the narrative bug report. Apply a **−30 confidence penalty** later.
3. **Give up:** if neither produces a runnable script, mark the issue `verify-inconclusive`, post a short comment explaining why, and move on. Do not provision a Brev box.

Save the chosen script to `./reproducer.sh`. Both verbatim and synthesized scripts will be quoted in the final comment as evidence.

---

## Step 7: Reuse or Provision a Brev Box

The skill prefers reuse over provisioning. A pool of `verify-stale-*` boxes (CPU and GPU) can be kept warm; reuse the matching one if available, otherwise provision.

```bash
# Ensure an active Brev session. brev ls fails if not authenticated.
brev ls --json >/dev/null 2>&1 || brev login

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
    # CPU case: pass an explicit --type from your team's allowed CPU SKUs
    # (brev create defaults to GPU). Pin this in your team config.
    brev create "$INSTANCE_NAME" --type "<your-team's-CPU-SKU>"
  fi

  PROVISIONED_NEW=1
fi

# Cleanup runs on success, error, and SIGINT.
# Delete only what we provisioned. Reused boxes stay warm for next time.
trap '[ "$PROVISIONED_NEW" = "1" ] && brev delete "$INSTANCE_NAME" --yes || true' EXIT
```

Wallclock cap per verification: **15 minutes** including reuse-check, install, and reproduction. If a provisioned box isn't ready in time, abort and treat as an infra failure (Step 11).

---

## Step 8: Reset, Install Latest, Run the Reproducer

Even on a reused box, reset NemoClaw state before installing — hermeticity matters more than the few seconds saved.

```bash
# Reset prior NemoClaw state on the box (safe no-op on a fresh box).
brev exec "$INSTANCE_NAME" "rm -rf ~/.nemoclaw 2>/dev/null; sudo rm -f /usr/local/bin/nemoclaw 2>/dev/null; true"

# Install latest NemoClaw.
brev exec "$INSTANCE_NAME" "curl -fsSL https://nemoclaw.nvidia.com/install.sh | bash"
brev exec "$INSTANCE_NAME" "nemoclaw --version"

# Copy and run the extracted reproducer; capture full transcript.
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" @reproducer-runner.sh 2>&1 | tee ./transcript.log
```

If the install itself fails (e.g. installer regression — see #3058 for a current example), this is an **infra failure** — see Step 11. Do not score or label the issue.

For interactive debugging when something looks off:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 9: Score Confidence

Start at 0. Apply each rule that fires.

| Signal | Delta |
|---|---|
| Reproducer ran cleanly on latest, exit 0, expected output observed | +50 |
| Commits between reported version and `$LATEST` touch the implicated component (`git log v<reported>..$LATEST -- <path>`) | +25 |
| A merged PR mentions this issue number or its symptom | +25 |
| Reproducer was LLM-synthesized, not extracted verbatim | −30 |
| Any partial error, warning, or flaky behavior in the repro run | −50 |

Total is clamped to `[0, 100]`.

**Action:**

| Score | Label | Comment |
|---|---|---|
| ≥85 | `fixed-on-latest` | Evidence-rich, no @-mention. |
| 60–84 | `fixed-on-latest` | Evidence-rich, **@-mention the original reporter** to confirm. |
| <60 | `verify-inconclusive` | Short, honest "couldn't verify" explanation. |

The skill **never closes issues**. A maintainer pulls that trigger after reviewing the label and comment.

---

## Step 10: Compose and Post the Comment

**Redaction pass before posting.** Strip from any text quoted out of the issue body:

- Anything matching `(?i)(token|secret|password|api[_-]?key|bearer)[^\n]*[:=][^\n]*`
- URLs containing `@` (basic-auth credentials).
- File paths under the reporter's home directory (replace with `~/`).

**Comment template:**

````markdown
## Stale-issue verification — automated

**Reported on:** v0.0.31
**Verified on:** v0.0.35 (commit abc1234)
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04 / <CUDA version if GPU>
**Reproducer source:** extracted verbatim from issue body | LLM-synthesized from narrative

**Result:** not reproducible — exit 0, expected output observed.
**Confidence:** 88 / 100. Labelling `fixed-on-latest`.

<details><summary>Reproduction transcript</summary>

```text
<full transcript here>
```

</details>

<details><summary>Relevant changes since v0.0.31</summary>

- abc1234 — fix: <commit subject>
- def5678 — refactor: <commit subject>

</details>

If this verification is wrong, please reopen the issue with a comment and the skill will re-verify on the next release.

<!-- nemoclaw-verify-stale v1 -->
````

The trailing HTML comment is the **idempotency marker** Step 3 looks for. Never omit it.

**Post the comment and apply the label:**

```bash
gh issue comment "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --body-file comment.md
gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "fixed-on-latest"
# or for <60:
# gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "verify-inconclusive"
```

---

## Step 11: Infra Failure Handling

If reuse-check, provisioning, install, or the test harness itself fails (not the reproducer):

- Print the error.
- Apply **no label** — infra failures must not pollute the verification record.
- Post a short comment **only if explicitly requested by the invoking user**. Default is silent move-on.
- Continue to the next candidate in batch mode.

The next weekly run retries naturally.

---

## Step 12: Log to Activity

After each issue (verified, inconclusive, or infra-failed), append to `~/development/daily-rhythm/activity/nemoclaw-verify-stale-log.md`.

```markdown
### NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Reported on:** v0.0.31
**Verified on:** v0.0.35
**Environment:** CPU | GPU (<instance type>)
**Box:** reused <name> | provisioned <name>
**Reproducer:** verbatim | synthesized | none
**Confidence:** 88 / 100
**Label applied:** fixed-on-latest | verify-inconclusive | none (infra)
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
