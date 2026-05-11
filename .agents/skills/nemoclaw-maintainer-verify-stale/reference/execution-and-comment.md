<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Execution, Scoring, and Comment Reference

This file holds Steps 7–12 of the `nemoclaw-maintainer-verify-stale` workflow (everything after the candidate has cleared the local-first short-circuit in Step 6.7). The parent SKILL.md handles candidate filtering, version parsing, environment classification, reproducer extraction, preconditions, and the local-first decision; once a Brev run is committed to, follow this file.

## Contents

- **[Step 7: Reuse or Provision a Brev Box](#step-7-reuse-or-provision-a-brev-box)** — concurrency cap, runtime CPU SKU picking, file-based API key copy, cleanup trap.
- **[Step 8: Validate on Baseline, Verify on Latest](#step-8-validate-on-baseline-verify-on-latest)** — comprehensive reset, baseline install (Step 8a), reproducer dependency bootstrap (8a.5), brev-exec environment quirks (8a.5b), baseline run (8b), synth-repro retry (8c), latest install (8d), architectural-drift check (8d.5), performance-bug verification (8e), rebuild-cycle verification (8f).
- **[Step 8.5: Detect "Behavior Changed by Design"](#step-85-detect-behavior-changed-by-design)** — three signals, related-failure-mode pre-check, test-coverage check, self-verification, by-design comment template.
- **[Step 9: Score Confidence](#step-9-score-confidence)** — +50 / +25 / +25 / −30 / −50 rubric, baseline-validation cap-at-84, path extraction (commits-touched), PR-search (PR-mention).
- **[Step 10: Compose and Post the Comment](#step-10-compose-and-post-the-comment)** — redaction table (HTML→text pre-pass; JWT/PAT/NVAPI/base64/internal-host/email patterns), comment-authoring principle (300-word ceiling), per-verdict length defaults, mandatory caveats (cap, hardware substitution, verification mode, link self-verify), three templates (fixed/inconclusive, still-reproduces, by-design), unanswered-question prefix and dual @-mention variant.
- **[Step 11: Infra Failure Handling](#step-11-infra-failure-handling)** — sandbox-build rot is the dominant failure mode for any version >5–7 patches behind; cap-at-84 with reporter @-mention is by design.
- **[Step 12: Log to Activity](#step-12-log-to-activity)** — per-issue and per-session entries to `~/development/daily-rhythm/activity/nemoclaw-verify-stale-log.md`.
- **[Cadence](#cadence)** — weekly cron + manual single-issue invocation.
- **[Out of Scope (v1)](#out-of-scope-v1)** — auto-close, macOS verification, integration-credential bugs, service-account bot, versioned labels.
- **[Companion Behavior](#companion-behavior)** — `nemoclaw-maintainer-cut-release-tag` sweeps verification labels at release time.

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
  # Filter on .status to match the reuse query above — counting non-running boxes
  # would falsely block provisioning when prior boxes are stopped but not deleted.
  RUNNING=$(echo "$INSTANCES" | jq '[.[]? | select(.name | startswith("verify-stale-")) | select(.status == "RUNNING")] | length')
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
    # CPU case: pick the cheapest stoppable Linux SKU at runtime so the skill doesn't rot when
    # SKUs change. Bias the floor by reproducer-implied memory needs — the cheapest 2 GB SKU
    # cannot load a 4.8 GiB Ollama probe, and onboard fails at provider validation before any
    # sandbox-creation code runs. Surfaced during the #2007 e2e run (wasted ~25 min on a 2 GB
    # box that couldn't load `nemotron-3-nano:4b`).
    #
    # Memory floor heuristic:
    #   - Reproducer references Ollama or vLLM or names a model tag (e.g. `nemotron-3-nano:4b`,
    #     `llama3:8b`)        -> floor 16 GB (covers ~5 GB model + sandbox + gateway overhead).
    #   - Reproducer touches sandbox onboarding without a local model server   -> floor 8 GB.
    #   - Pure CLI-surface bug (no sandbox, no model)                          -> floor 4 GB.
    # Override the auto-pick by exporting VERIFY_STALE_CPU_TYPE if the team has hard preferences.
    CPU_RAM_FLOOR=${CPU_RAM_FLOOR:-8}
    CPU_TYPE=${VERIFY_STALE_CPU_TYPE:-$(brev search cpu --sort price --json \
      | jq -r --argjson floor "$CPU_RAM_FLOOR" \
          '[.[] | select(.stoppable == true and .ram_gb >= $floor)] | .[0].type')}
    [ -n "$CPU_TYPE" ] || { echo "ERROR: no stoppable CPU SKU with >= ${CPU_RAM_FLOOR} GB RAM"; exit 1; }
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

Wallclock cap per verification: **60 minutes** default. The cap accommodates two full install passes (baseline + latest), comprehensive resets between them, and any reproducer dependency bootstrapping (Step 8a.5) — most of which run sequentially against a single Brev box. Bugs that genuinely require more than an hour to manifest fall out of v1 scope; if a provisioned box isn't ready in time, abort and treat as an infra failure (Step 11).

The previous design had a 25-min default with a 60-min extension for time-sensitive bugs (`memory leak`, `over time`, etc.). That split optimised for the wrong constraint — most issues fit comfortably under 60 min, and the keyword-based extension forced re-runs whenever a real install or bootstrap took longer than the optimistic 25-min budget. Single 60-min cap removes that paper cut.

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
# Anchor pkill patterns to "/nemoclaw" / "/openshell" path components so the kill doesn't
# match unrelated processes that happen to mention these strings (including the agent
# harness running this skill if its working dir contains the word).
pkill -9 -f '/nemoclaw([[:space:]]|$)' 2>/dev/null || true
pkill -9 -f '/openshell([[:space:]]|$)' 2>/dev/null || true
docker ps -a --filter "name=openshell-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
docker ps -a --filter "name=nemoclaw-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
# Sandbox state lives in ~/.openclaw (default-writable since #2227); ~/.nemoclaw holds CLI state.
# Wipe both so the latest install starts clean.
rm -rf ~/.nemoclaw ~/.openclaw 2>/dev/null
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

# Pass the provider env vars through so install.sh's bundled `[3/3] Onboarding` step
# doesn't fall back to the default `build` (NIM) provider — which requires NVIDIA_API_KEY
# and otherwise fails the install with a misleading error. When NEMOCLAW_PROVIDER=ollama
# (the common case), the bundled onboard uses the local Ollama we set up in Step 8a.5
# and either succeeds (ideal) or fails on a real Dockerfile/sandbox-build issue (which
# is what we want to detect). Pass NVIDIA_API_KEY only if the maintainer provided one
# at Step 5's prompt.
# Read NVIDIA_API_KEY from ~/.nvidia-api-key on the BOX (not from this shell's argv).
# The Step 5 propagation block already brev-copy'd the key file with 600 perms.
brev exec "$INSTANCE_NAME" "
  if [ -f ~/.nvidia-api-key ]; then export NVIDIA_API_KEY=\$(cat ~/.nvidia-api-key); fi
  NEMOCLAW_INSTALL_TAG=$REPORTED_VERSION \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER:-ollama} \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL:-nemotron-3-nano:4b} \
    NEMOCLAW_SANDBOX_NAME=verify-stale-install \
    bash -c 'curl -fsSL $INSTALL_URL | bash'
" || BASELINE_INSTALL_FAILED=1

# Verify the resolved install version matches the requested version. This guards against the
# `VAR=val curl ... | bash` shell-scoping footgun where the env var binds to curl, not the
# downstream bash, and the install silently falls through to "latest". Surfaced during a
# rot-debugging investigation where v0.0.36 was silently installed when v0.0.26 was requested
# and several minutes of "convincing" output ran before anyone noticed. Always print the
# resolved state, never trust the requested state.
RESOLVED=$(brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" 2>&1 | tail -1)
echo "[verify-stale] baseline requested: $REPORTED_VERSION; resolved: $RESOLVED"
case "$RESOLVED" in
  *"$REPORTED_VERSION"*) ;;  # match — proceed
  *)
    echo "ERROR: baseline install resolved to '$RESOLVED' but $REPORTED_VERSION was requested."
    echo "  Common cause: env-var scoping in the install command. Verify the env vars are on"
    echo "  the BASH side of the curl|bash pipe, not the curl side. Setting"
    echo "  BASELINE_INSTALL_FAILED=1 to prevent verifying against the wrong version."
    BASELINE_INSTALL_FAILED=1
    ;;
esac

# The bundled onboard creates a sandbox name we don't want carrying through to the reproducer.
# Use a hyphen-only name (NemoClaw's name validator rejects underscores). Destroy it so the
# reproducer starts from a clean state.
brev exec "$INSTANCE_NAME" "sg docker -c 'nemoclaw destroy --all --force 2>/dev/null || true'"
```

If install fails (old releases rot — installer URLs, deps, OS images all drift over time, or the in-image Dockerfile patch step asserts against a code shape that's since changed), set `BASELINE_INSTALL_FAILED=1` and **skip 8b/8c**, going straight to 8d. Note "baseline-install-skipped" or "baseline-build-skipped" in the final comment depending on which phase rotted. Step 9's scoring rule handles the degraded mode (cap at 84).

**The reproducer's own `nemoclaw onboard` (Step 8b) must pass `--fresh`.** If install.sh's bundled onboard was in an in-progress or failed state when we destroyed the install sandbox, the reproducer's onboard would error with `Previous onboarding session failed. Re-run with --fresh to discard it`. `--fresh` ensures a clean start.

### Step 8a.5: Bootstrap reproducer dependencies

Brev's stock CPU images ship with NemoClaw installable but not the broader ecosystem the reproducer may need — local model servers (Ollama, vLLM), inference providers, third-party CLIs. **Default to maximum faithfulness: install the actual dependency the reporter used rather than substituting a stub.** Substituting trades faithfulness for speed; that trade is rarely worth it on a 60-min budget, and it almost always introduces a confound that makes the verdict less trustworthy.

**When to bootstrap (not substitute):**

- The reproducer references a specific model/server runtime (`NEMOCLAW_PROVIDER=ollama`, `NEMOCLAW_PROVIDER=vllm`, etc.).
- The reproducer references a specific model name with a tag (`nemotron-3-nano:4b`, `llama3:8b`, etc.).
- The reporter's environment in the issue body shows a configured provider (e.g., `OpenShell CLI: 0.0.26` plus an Ollama running on host).

**When to substitute (with -30 penalty):**

- Provider requires an API key the skill cannot safely supply (NIM, OpenAI, Anthropic, etc.). Stubbing a key won't pass validation faithfully and a real key shouldn't sit in a verify-stale run. Apply the -30 penalty (treat as synth-repro per Step 8b) and document the substitution in the comment.
- The bug is *provably* independent of the dependency (e.g., a CLI argument-parsing bug that errors before any provider runs). Note this explicitly in the comment.

**Canonical bootstraps:**

```bash
# Ollama + a specific model.
# The Ollama installer registers a systemd service (`ollama.service`) so the
# daemon survives between brev exec calls.
brev exec "$INSTANCE_NAME" "curl -fsSL https://ollama.com/install.sh | sh"
brev exec "$INSTANCE_NAME" "sudo systemctl start ollama && sleep 3"
brev exec "$INSTANCE_NAME" "ollama pull <model>"
brev exec "$INSTANCE_NAME" "ollama list"   # confirm before continuing
```

```bash
# vLLM + a model (HuggingFace-hosted).
brev exec "$INSTANCE_NAME" "pip install --quiet vllm"
brev exec "$INSTANCE_NAME" "nohup python -m vllm.entrypoints.openai.api_server --model <model> --host 127.0.0.1 --port 8000 >/var/log/vllm.log 2>&1 &"
brev exec "$INSTANCE_NAME" "sleep 30 && curl -fsS http://127.0.0.1:8000/v1/models"
```

Bootstrap **once before Step 8b's baseline run** and reuse for Step 8d's latest run. Don't reset Ollama/vLLM state between baseline and latest in the comprehensive reset — model downloads are expensive and unrelated to the NemoClaw install. Adjust the reset script to skip these external services explicitly if needed.

**If bootstrap fails** (network issue pulling the model, service won't start, etc.), this is an infra failure — abort to Step 11. Do not silently substitute; the user opted into faithfulness for a reason.

**Ollama coverage table.** Ollama is the default provider for verification runs because it's free, local, and self-hosted. It covers most bug classes faithfully but not all. Use this table to decide whether Ollama is sufficient or whether Step 5's API-key prompt should fire:

| Bug class | Ollama covers? | Notes |
|---|---|---|
| CLI surface (subcommand parsing, flag handling, oclif dispatch) | ✓ Always | Provider not exercised |
| Sandbox structure (build, file permissions, mounts, layout) | ✓ Always | Provider not exercised |
| Networking / policy (port forwards, NAT, egress rules, channels guards) | ✓ Always | Provider not exercised |
| Generic inference flow (does an agent turn complete, does the proxy route correctly) | ✓ Usually | Ollama can fail in the same shape as NIM/Gemini for most flow bugs |
| Provider-specific behavior (`Provider: NVIDIA` symptom, NIM-only error handling, `Provider: Gemini` quirks) | ✗ No | Different code paths; substitution doesn't exercise the bug |
| Model-specific behavior (`gemini-flash-3-preview` doesn't handle prompt X, `nemotron-3-nano:4b` works fine) | ✗ No | Wrong model = wrong outputs |
| Ollama-shape-specific (#2519 "Ollama-local 401" — local-vs-networked Ollama config) | △ Sometimes | A generic Ollama install may or may not reproduce; may need specific configuration |
| Performance / latency on specific silicon | ✗ No | Hardware substitution caveat (Step 10) and Step 8e perf rubric apply |
| Quota / rate-limit / API-key validation | ✗ No | Ollama doesn't have those failure modes |

When the table says ✗ No or △ Sometimes, Step 5's API-key prompt fires. When it says ✓, proceed with Ollama and skip the prompt.

### Step 8a.5b: Brev exec environment quirks

Two non-obvious gotchas surfaced during the #2007 e2e run that every subsequent `brev exec` call has to handle. Encode them once here so reproducer scripts don't have to relearn each time.

**PATH does not include `~/.local/bin` in non-login shells.** `nemoclaw`'s installer drops a shim at `~/.local/bin/nemoclaw` and updates PATH via `~/.bashrc` / `~/.profile`. `brev exec` spawns non-login, non-interactive shells that don't source those files, so a bare `brev exec "$INSTANCE" "nemoclaw --version"` returns `command not found` on a freshly-installed box. Fix: every reproducer script must explicitly export PATH at the top, OR every `brev exec` call must wrap with `bash -lc '...'`.

```bash
# Reproducer scripts: prepend this line.
export PATH="$HOME/.local/bin:$PATH"

# Or equivalently when calling brev exec ad-hoc:
brev exec "$INSTANCE" "bash -lc 'nemoclaw --version'"
```

**Docker group requires `sg docker -c '...'` after `usermod -aG`.** Adding the user to the `docker` group (`sudo usermod -aG docker ubuntu`) takes effect for new login sessions, but `brev exec` calls in the same Brev session keep the old gid. The reproducer's `nemoclaw onboard` will fail with `permission denied while connecting to /var/run/docker.sock` unless the call runs in a subshell with the docker group active.

```bash
# Reproducer execution: wrap with sg docker.
brev exec "$INSTANCE" "sg docker -c 'bash ~/reproducer.sh'"
```

Both patterns appear in the canonical setup script committed alongside the skill (or are encoded in your reproducer wrapper). Don't rely on the user discovering them mid-run.

**`openshell sandbox exec` argument-order footgun.** When the reproducer needs to run a command *inside* the sandbox (channels-guard checks, in-sandbox file inspection, etc.), the correct non-interactive form uses `-n <name>` and a `--` separator:

```bash
# Correct:
openshell sandbox exec -n ai -- bash -c 'source /sandbox/.bashrc; openclaw channels add telegram; echo "EXIT=$?"'

# Wrong (silently auto-detects sandbox by "last used", stuffs the leftover positional
# `ai` into bash's $0, prints "/bin/bash: line 1: ai: command not found" — the
# reproducer appears to fail but actually never ran inside the sandbox at all):
openshell sandbox exec ai bash -c '...'
```

Issue #2592's first run hit this — wasted ~15 min before the maintainer noticed. Always use the `-n <name> -- <cmd>` form when the reproducer touches in-sandbox commands.

**`brev exec` SSH-drop re-execution guard.** Brev's CLI silently retries from the top when the SSH connection drops mid-run, producing two parallel reproducer executions (we hit this on #2592 — one onboard process clobbered another's state, and both got billed). Use a sentinel file in the reproducer wrapper to make the script idempotent:

```bash
# At the top of the reproducer wrapper script:
SENTINEL=~/.verify-stale-running
if [ -f "$SENTINEL" ]; then
  echo "ERROR: another verify-stale run is in progress (sentinel: $SENTINEL)."
  echo "       If you're sure no other run is active, rm $SENTINEL and re-invoke."
  exit 1
fi
trap 'rm -f "$SENTINEL"' EXIT
touch "$SENTINEL"
```

The sentinel survives an SSH drop because it lives on the Brev box's filesystem; the trap removes it on script exit. A second `brev exec` invocation that tries to retry from the top will hit the sentinel and bail instead of double-running.

---

### Step 8b: Run reproducer on baseline, compare to issue symptom

If `./reproducer.sh` exists (verbatim from Step 6), run it. Otherwise synth on demand from the issue body (apply −30 penalty now, locked in for the rest of the run).

**Interactive subcommand handling.** Many `nemoclaw onboard` / `nemoclaw configure` invocations prompt for input and will hang in a non-interactive shell. Auto-detect such subcommands in the script and apply, in order:

1. Add `--non-interactive` if the version supports it.
2. Add `--dangerously-skip-prompts` (issue #2168 confirmed this exists for at least some Jetson paths).
3. Pre-feed answers via stdin: `printf 'yes\n\n\n' | nemoclaw onboard ...`

If none work, route the script to Step 8c (synth-repro) so the LLM can rewrite it using non-interactive equivalents.

```bash
# `brev exec` spawns a non-login shell, so ~/.local/bin (where the nemoclaw binary lives
# after install) is not on PATH unless we export it. The reproducer script itself must
# use `sg docker -c '...'` blocks for any Docker-touching command — Step 8a.5b covers
# that requirement; double-wrapping with sg docker on the outer call breaks nested-quote
# escaping in some bash versions.
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" 'export PATH="$HOME/.local/bin:$PATH" && bash ~/reproducer.sh' 2>&1 | tee ./baseline-transcript.log
```

**Log-scraping (when `BUG_CLASS=log-only`).** Some bugs describe symptoms that show up in internal log files, not the reproducer's stdout/stderr — e.g., #1642 "see lots of error in openclaw log," #2611 "os.networkInterfaces guard errors." After running the reproducer, also pull the relevant logs from inside the sandbox and search them for the issue's symptom phrase:

```bash
# Common NemoClaw / OpenClaw / OpenShell log paths inside the sandbox.
brev exec "$INSTANCE_NAME" "sg docker -c 'cat ~/.openclaw/logs/*.log /var/log/nemoclaw/*.log 2>/dev/null'" \
  | tee ./baseline-logs.log

# Search the log capture for the issue's symptom phrase too, not just the transcript.
grep -F "<symptom phrase from issue body>" ./baseline-logs.log
```

For functional bugs the reproducer's stdout is sufficient; for log-only bugs the transcript may be clean but the log capture has the symptom. Both halves feed into the match rubric below.

**Flake-detection retry.** Even for `functional` bugs, race-prone reproducers (TUI rendering, network policy negotiation, concurrent sandbox state) can produce inconsistent results. Run baseline three times if the first run shows the symptom inconsistently — same script, same env, just three back-to-back invocations. If the three runs disagree, that's signal:

| 3-run baseline result | Verdict |
|---|---|
| All three reproduce the symptom | Strong baseline match → continue to 8d |
| All three are clean (no symptom) | Reproducer doesn't expose the bug on baseline → Step 8c synth-repro |
| Mixed (1 or 2 of 3 show the symptom) | Flake-prone reproducer. Note "flake suspected" in the comment; apply −25 to Step 9 score; downgrade `+50 latest clean` to `+25` because a clean latest run could just be the lucky path of an intermittent bug |

Skip flake retry for `performance` and `rebuild-cycle` classes — those have their own multi-run rubrics in Steps 8e and 8f.

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
brev exec "$INSTANCE_NAME" "
  if [ -f ~/.nvidia-api-key ]; then export NVIDIA_API_KEY=\$(cat ~/.nvidia-api-key); fi
  curl -fsSL $INSTALL_URL | bash
"

# Same resolved-version check as Step 8a — guard against env-var scoping or default fallthrough
# silently installing the wrong version. The latest install should resolve to $LATEST.
RESOLVED=$(brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" 2>&1 | tail -1)
echo "[verify-stale] latest requested: $LATEST; resolved: $RESOLVED"
case "$RESOLVED" in
  *"$LATEST"*) ;;  # match — proceed
  *) echo "WARN: latest install resolved to '$RESOLVED' (expected match for $LATEST). Proceeding but flag in comment." ;;
esac

# OpenShell version pin — surfaced from #1642's e2e run. Latest's blueprint.yaml may set
# `max_openshell_version` below what the OpenShell installer would otherwise grab. The
# baseline phase (Step 8a) installed whichever OpenShell was current at reported-version,
# which can be newer than latest's cap (e.g., reported v0.0.6 → installed openshell 0.0.37,
# latest v0.0.38 caps at 0.0.36, onboard preflight refuses to run). Re-pin from latest's
# repo so onboard preflight passes; if the new pin is OLDER than the installed binary,
# install-openshell.sh refuses the downgrade — fall back to direct GitHub download.
brev exec "$INSTANCE_NAME" '
  set -e
  cd ~/NemoClaw
  git fetch --depth 1 origin tag "'"$LATEST"'" 2>&1 | tail -2
  git checkout -- . 2>/dev/null || true
  git checkout "'"$LATEST"'" 2>&1 | tail -2

  MAX_OS=$(grep -E "^max_openshell_version:" nemoclaw-blueprint/blueprint.yaml 2>/dev/null | awk "{print \$2}" | tr -d "\"" | tr -d "v")
  CUR_OS=$(openshell --version 2>&1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || echo 0.0.0)
  echo "[verify-stale] openshell pin: blueprint max=$MAX_OS, currently installed=$CUR_OS"

  if [ -n "$MAX_OS" ] && [ "$(printf "%s\n%s\n" "$CUR_OS" "$MAX_OS" | sort -V | tail -1)" != "$MAX_OS" ]; then
    echo "[verify-stale] currently installed openshell ($CUR_OS) is newer than blueprint cap ($MAX_OS) — force-downgrading"
    sudo rm -f /usr/local/bin/openshell
    cd /tmp
    curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/v$MAX_OS/openshell-x86_64-unknown-linux-musl.tar.gz" -o openshell-pin.tar.gz
    tar -xzf openshell-pin.tar.gz
    sudo install -m 755 ./openshell /usr/local/bin/openshell
    openshell --version
  else
    sudo bash scripts/install-openshell.sh 2>&1 | tail -3
  fi
'

brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
# Same PATH safeguard as the baseline call — non-login shells don't pick up ~/.local/bin
# automatically. The reproducer's internal `sg docker -c '...'` blocks cover Docker access.
brev exec "$INSTANCE_NAME" 'export PATH="$HOME/.local/bin:$PATH" && bash ~/reproducer.sh' 2>&1 | tee ./latest-transcript.log
```

If the install of **latest** fails (e.g. installer regression — see #3058 for a current example), this is an infra failure — see Step 11. Do not score or label the issue.

If install succeeds, `latest-transcript.log` is the input to Step 9 scoring.

For interactive debugging when something looks off:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 8d.5: Architectural-Drift Check

Cross-version verification compares two moving targets: the reproducer assumes `$REPORTED_VERSION`'s tooling surface, and `$LATEST` may have rewritten the surface entirely. If the *tool* the reproducer relies on (CLI subcommand, output table, log file location) was reworked between the two tags, an "empty / clean output on latest" can mean either "bug fixed" OR "we're looking at a deprecated tracking surface." Without this check, the latter silently registers as the former — a class of false positive.

**Detection** — pickaxe the diff between tags for the reproducer's tool name and watch for the CLI itself being touched, not just its consumers:

```bash
# Extract the primary verification command from the reproducer (e.g. "openshell forward list").
TOOL=$(grep -oE '\b(openshell|nemoclaw)[[:space:]]+[a-z-]+' reproducer.sh | sort -u)

# Pickaxe each tool name across the version range.
for t in $TOOL; do
  echo "=== drift check: $t ==="
  git log "$REPORTED_VERSION".."$LATEST" -S"$t" --oneline -- src/ bin/ nemoclaw/src/ 2>&1 | head -5
done
```

If a tool is touched, drift is suspected.

**Multi-axis verification** — when drift is suspected, do not rely on the reproducer's expected output alone. Pick OS-level surfaces that would show the buggy state regardless of which CLI tracks it. For port-forwarding bugs (the #2007 case), the canonical five-axis pattern:

| # | Surface | Command |
|---|---|---|
| 1 | Reproducer's stated check | as written in the issue body |
| 2 | Host TCP listeners | `sudo ss -tlnp` |
| 3 | iptables NAT redirects | `sudo iptables -t nat -L -n` |
| 4 | Docker port mappings | `docker ps --format '{{.Names}} {{.Ports}}'` |
| 5 | Active SSH tunnels | `ps -ef \| grep 'ssh.*-L'` |

Adapt the axes to the bug class. For filesystem bugs: `find`, `lsattr`, `stat`. For network policy bugs: `iptables -L`, container netns, gateway logs. The principle is the same — pick at least three independent surfaces that would each independently show the buggy state if it were present.

**Action when drift is suspected:**

- Run the multi-axis pattern after Step 8d's reproducer.
- The verdict requires **every relevant axis to be clean** — not just the reproducer's surface — before claiming `fixed-on-latest`.
- Quote the multi-axis evidence in the Step 10 comment as a table; this is exactly what makes "fixed" defensible when the original tooling no longer reflects the underlying behavior.
- If any axis still shows the buggy state, the bug is NOT fixed even if the reproducer's surface is clean. Escalate to "still reproduces" (Step 9 special case).

**When drift is NOT suspected** (the reproducer's tool is unchanged in the version range): the reproducer's expected output is sufficient, no multi-axis verification needed.

---

## Step 8e: Performance-Bug Verification (when `BUG_CLASS=performance`)

Performance bugs (#2598 "10s P50", #2600 "hangs ~2 min", #2733 Ollama tool-call leak over time) can't be answered by the standard exit-code + symptom-phrase rubric — one clean reproducer run doesn't tell you the p50 budget is met; one slow run doesn't tell you the bug still reproduces. Replace Step 8b's match with a measurement-and-distribution rubric:

1. **Parse the SLA from the issue body.** Extract numeric latency thresholds: `10s P50`, `200ms`, `under 5 seconds`, `~2 min`. Save as `SLA_P50_MS`, `SLA_P90_MS`, etc. If no numeric SLA is in the body, route to Step 8c synth-repro to ask the reporter (via comment) for one — without a target, the verdict is undefined.
2. **Run the reproducer N=10 times** on each side (baseline + latest), capturing per-run latency:

   ```bash
   for i in $(seq 1 10); do
     /usr/bin/time -f '%e' bash ~/reproducer.sh >/dev/null 2>>./latest-perf.log
   done
   ```

3. **Compute p50 and p90** for both sides. `sort -n ./latest-perf.log | awk 'NR==5'` for p50 of 10 runs.
4. **Match rubric:**
   - Latest's p50 within the SLA AND baseline's p50 outside the SLA → bug fixed; same Step 9 scoring (subject to baseline-validation gate).
   - Latest's p50 outside the SLA → bug still reproduces (Step 9 special case).
   - Latest p50 within SLA AND baseline p50 also within SLA → reproducer doesn't actually exercise the bug; route to Step 8c synth-repro.

**Hardware-substitution caveat.** Performance numbers are silicon-dependent. When the issue is `Platform: DGX Spark` or `Platform: GB10` and we're measuring on a Brev x86 GPU SKU, the comment must say so explicitly: a Brev p50 of 1.5s on a `H100` does not prove the DGX Spark p50 is fixed. Cap the score at 60 unless the bug is clearly silicon-independent (e.g. an algorithmic regression in user-space JS that would manifest the same on any silicon).

---

## Step 8f: Rebuild-Cycle Verification (when `BUG_CLASS=rebuild-cycle`)

Rebuild-cycle bugs (#2701 "Pod recreate wipes `/tmp/nemoclaw-proxy-env.sh`," issues describing "configuration is not persisted across rebuilds") only manifest when sandbox state crosses a destroy/recreate boundary. A single onboard run can't trigger the symptom. Replace Step 8b's match with a run-rebuild-rerun harness:

1. **First onboard.** Run the reproducer once to establish initial state. Capture relevant artifacts (config files, env vars, sandbox metadata) — the issue body usually names what should persist:

   ```bash
   brev exec "$INSTANCE_NAME" "sg docker -c 'cat <files-mentioned-in-issue> 2>&1'" | tee ./pre-rebuild.log
   ```

2. **Trigger the rebuild.** Use `nemoclaw destroy --all --force` followed by `nemoclaw onboard` with the same env vars. Do NOT comprehensive-reset between (the point is to test the destroy/recreate, not start from scratch).

3. **Re-capture the same artifacts** post-rebuild:

   ```bash
   brev exec "$INSTANCE_NAME" "sg docker -c 'cat <same-files> 2>&1'" | tee ./post-rebuild.log
   ```

4. **Diff and match.** The bug is "X gets wiped / changes / regresses across rebuild." Compare pre-rebuild vs post-rebuild captures to the issue's expected behavior:
   - Pre and post agree (artifact preserved) AND issue says it should be preserved → bug fixed
   - Pre and post differ (artifact wiped) AND issue says it gets wiped → bug still reproduces
   - Pre and post agree AND issue says it gets wiped → reproducer doesn't exercise the bug; Step 8c synth-repro

The harness still uses Step 9's scoring framework — `+50 latest clean (artifact preserved)`, etc. — but the "what gets compared" axis is the diff, not the symptom phrase.

---

## Step 8.5: Detect "Behavior Changed by Design"

Before scoring, check whether the symptom is intentional. Some bugs are filed against behavior that was **deliberately changed or removed** in a merged PR — running the standard rubric on these produces misleading verdicts. The symptom "still reproduces" but the right answer is "won't fix, see PR #X." Issue #2791 is the prototype: `config set` was removed in PR #2227, the reporter tested a version that already had it gone, and a standard rubric run would have buried that context under a low-confidence `verify-inconclusive` label.

This step is split into substeps so the rigor is mechanical, not optional. Every claim in the final comment must be backed by a verifiable evidence block — a comment URL with quoted phrase, a commit SHA with diff range, or a grep command with its actual output. Hand-wavy claims fail Step 8.5d's self-verification pass and force a bail to `verify-inconclusive`.

### Step 8.5a: Run signal detection

Any single signal is sufficient to trigger the by-design branch.

**Signal 1 — Maintainer attribution in comments.** Any comment by an author with `authorAssociation` of `MEMBER`, `OWNER`, or `COLLABORATOR` matches `removed in #\d+`, `removed in [Pp][Rr] ?#\d+`, `by design`, `wontfix`, `won't fix`, `not a bug`, or `intentional`.

```bash
gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq '.comments[]
        | select(.authorAssociation == "MEMBER" or .authorAssociation == "OWNER" or .authorAssociation == "COLLABORATOR")
        | select(.body | test("removed in #\\d+|by design|wontfix|won.t fix|not a bug|intentional"; "i"))
        | {url, author: .author.login, body}'
```

Capture for evidence: comment URL + author login + the exact quoted phrase.

**Signal 2 — Removal commit in range.** A commit between the reported version and `$LATEST` deletes the symbol implicated by the reproducer (CLI subcommand, function, flag). The commit subject does NOT need to mention "remove" / "delete" — many removals ride into a `refactor(...)` or `feat(...)` commit (e.g. PR #2227 removed `--dangerously-skip-permissions` under a `refactor(sandbox): ...` subject). Use git's pickaxe to find the responsible commit by content:

```bash
# Pickaxe: list every commit whose diff changes the count of <symbol> occurrences.
# Reverse order so the earliest removal commit lands first in the list.
git log "$REPORTED_VERSION".."$LATEST" -S'<symbol>' --reverse --oneline -- src/ bin/ nemoclaw/src/

# Subject-keyword narrowing is only a SUPPLEMENTARY lookup — useful when the
# pickaxe returns many commits and you want to focus on the obviously-removal one.
git log "$REPORTED_VERSION".."$LATEST" --grep='remove\|delete\|drop\|deprecate' -i --oneline

# For each candidate, confirm the diff actually deletes the symbol (not just renames or moves it).
git log -p <candidate-sha> -- src/ bin/ nemoclaw/src/ | grep -nE '^-.*\b<symbol>\b'
```

Capture for evidence: commit SHA + each `file:line` block of deletions touching the symbol. Note the commit's actual subject — don't assume it says "remove."

**Signal 3 — Symbol absent in both reported version and latest.** The implicated symbol (e.g. `config set`) is not present in either tag's source tree — meaning the responsible change landed before the version the reporter tested. This is the #2791 case.

```bash
git grep -n "<symbol>" "$REPORTED_VERSION" -- src/ bin/ nemoclaw/   # expect: zero matches (or shim-only — see sub-case)
git grep -n "<symbol>" "$LATEST"            -- src/ bin/ nemoclaw/   # expect: zero matches (or shim-only)
```

Capture for evidence: both grep commands and their (empty) outputs.

**Sub-case for signals 2 and 3 — vestigial deprecation shims.** It's common for a removed symbol to survive in latest *only* as a deprecation message (e.g., a CLI subcommand that prints `"--<flag> was removed; use <X> instead"` and exits non-zero). When a grep returns matches in latest, inspect each `file:line`. If every match is a deprecation stub with no functional effect on the bug-as-filed, signal 2 or 3 still fires; record the shim locations and behavior as a separate evidence block. Do not silently treat shims as functional code, and do not silently treat them as absence.

### Step 8.5b: Pre-check related failure modes

A by-design verdict says "the bug *as filed* can't reproduce." It does NOT say "every bug shaped like this is fixed." Before drafting the comment, search latest's source for code paths that could still produce the issue's described **symptom** (not the literal removed flag/symbol — the symptom).

```bash
# Use the issue's symptom keywords, not the removed symbol.
git grep -nE "<symptom-keyword-1>|<symptom-keyword-2>" "$LATEST" -- src/ nemoclaw/src/
```

For #2168 the literal flag is `--dangerously-skip-permissions`, but the symptom is "sandbox created but not registered in CLI." Grepping for `register.*[Ss]andbox`, the readiness-gate / cleanup-failure path in `src/lib/onboard.ts` surfaces as a related-but-different way to produce an orphan sandbox.

If a related failure mode is found, the by-design comment MUST include a "What's not literally the same bug" section that names it with `file:line`. Don't suppress the call-out by claiming "the symptom is impossible" when the symptom can be reached via a different path.

### Step 8.5c: Check existing test coverage

Search the repo for tests that exercise the NEW intended workflow (the one that replaced the removed symbol). Citing them strengthens the comment from "trust me, it was removed" to "the new workflow is exercised by these tests."

```bash
git grep -lnE "<new-workflow-keyword>" -- test/ nemoclaw/src/ 2>/dev/null | head -5
```

Cite at most three concrete test paths. If none exist, omit the section — do not invent paths.

### Step 8.5d: Self-verification pass before posting

Two passes, both required.

**Evidence pass.** Re-run every grep / git / `gh` command cited in the evidence blocks. If any cited `file:line`, commit SHA, or quoted output doesn't reproduce on a fresh invocation, **stop and revise** — or bail to `verify-inconclusive` if the discrepancy can't be resolved.

**Link pass.** Resolve at least one rendered markdown link from each section that has them — `What's structurally fixed`, `Vestigial references`, `Existing CI coverage`. Use `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=<tag>` (returns 200 + base64 content if the path exists at the tag, 404 otherwise) or `curl -fsI <blob-url>` (returns 200 if the blob renders). A broken link is worse than no link — it suggests verification work that didn't actually happen.

The cost of an incorrect "I checked and X is gone" claim in a public comment, or a 404 on a citation, is higher than spending a minute re-checking. This step exists because LLMs can confidently overstate and confidently invent paths; mechanical re-verification catches both.

### Step 8.5e: If any signal fires

- **Skip the Step 9 score table** entirely. The "exit 0 + expected output" axis doesn't apply when the expected output is no longer the contract.
- **Skip Brev provisioning** if the signal fires before Step 7 — a remote run would just confirm what static analysis already proved. (Signals 2 and 3 can run as soon as the reported version is parsed in Step 4.)
- **Apply label `status: wont-fix`** (the existing repo label — quote it on the CLI: `gh issue edit <num> --add-label "status: wont-fix"`). It's already in the Step 3 issue-type skip list, so a labelled issue is automatically excluded from future runs without needing a separate idempotency clause.
- **Use the by-design comment template below** instead of the standard Step 10 template.
- **@-mention the reporter** so they can object if the framing is wrong.
- **Never auto-close.** A maintainer pulls the trigger, same as the other label paths.

### By-design comment template

Mandatory sections in this order. Omit only the sections explicitly noted as omittable.

**Tag-anchoring + linking rule.** Every `file:line` citation, commit SHA, and test-path reference in the rendered comment MUST be a clickable markdown link to the verified-on tag (e.g., `v0.0.35`), not the maintainer's working `HEAD`. Lines drift between tags and main; tag-anchored links keep the citations reproducible by anyone reading the comment months later. Bare paths force the reader to navigate manually — that's a usability bug, not a stylistic preference.

Use these exact link formats:

- File only: `[src/lib/onboard.ts](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/onboard.ts)`
- File:line: `[src/lib/onboard.ts:4965](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/onboard.ts#L4965)`
- File:line-range: `[src/lib/commands/sandbox/connect.ts:25-31](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/commands/sandbox/connect.ts#L25-L31)`
- Commit SHA: `[5956a61](https://github.com/NVIDIA/NemoClaw/commit/5956a612e18047b9ab85b3a7e89f6b5dedb29190)` — short SHA as the link text, full SHA in the URL
- Test file: `[test/e2e/test-double-onboard.sh](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/test/e2e/test-double-onboard.sh)`
- PR/issue references: bare `#NNNN` works — GitHub auto-links these in comments on the same repo, no manual URL needed.

When greping for evidence, use `git grep -n "<symbol>" "$LATEST" -- ...` so the line numbers match the tagged blob. Then construct each link from `<file path> + verified-on tag + line number`.

The Step 8.5d self-verification pass MUST resolve at least one rendered link (e.g., `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=v0.0.35` or a `curl -fsI` to the blob URL) and confirm it returns the expected file. A broken link defeats the purpose of including the citation. If any link fails to resolve, fix it or bail to `verify-inconclusive`.

````markdown
## Stale-issue verification — behavior is by-design

**Reported on:** v0.0.<X>
**Verified on:** v0.0.<Y> (PR #<NNNN> first shipped in v0.0.<Z>)
**Verification mode:** static analysis at the verified-on tag — no runtime reproduction. Step 8.5 by-design short-circuits Brev provisioning because the responsible code change is already proven by the diff between `$REPORTED_VERSION` and `$LATEST`.
**Outcome:** symptom reproduces against the reproducer as filed, but the implicated behavior was intentionally changed.

### What's structurally fixed

- `<file:line>` — `<one-sentence summary of the change at that location>`
- `<file:line>` — `<…>`

The new workflow is `<one-sentence: how to do what the user was trying to do>`.

### Vestigial references

- `<file:line>` — `<deprecation behavior: e.g. "prints '--<flag> was removed; use <X> instead' and exits 1; no functional effect">`

(Omit this section entirely when the symbol is fully gone with no surviving stubs.)

### What's not literally the same bug

`<one-sentence acknowledgement of the related failure mode found in Step 8.5b, with file:line>` — OR — `None. The symptom requires the removed symbol; no related code path produces it on latest.`

### Existing CI coverage

- `<test/path/file>` — `<one-sentence: what this test demonstrates about the new workflow>`

(Omit when no direct test exists. Do not invent paths.)

### Recommendation

@<reporter> — please confirm the by-design framing is correct (the implicated `<symbol>` was intentionally removed, the original reproducer can no longer execute) and close as "won't fix / by design" if you agree. If a related symptom (e.g. `<related failure mode from above>`) is hitting you on ≥ v0.0.<Z>, please file a fresh issue with a v0.0.<Z>+ reproducer.

`<NVBugs cross-ref line — see below>`

<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->
````

**NVBugs cross-ref line.** If `NVBUGS_REF` was set in Step 4, append:

> NVBugs<NVBUGS_REF without brackets> will need a separate update; closing this GitHub issue won't propagate.

Otherwise omit the sentence.

**If no signal fires:** continue to Step 9 normally.

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
2. **Component-label-to-directory map.** Pick the first match. Paths verified against the current repo layout — drop any path that doesn't exist on the tag at `$LATEST` rather than passing it to `git log`.
   - `NemoClaw CLI` → `bin/`, `src/lib/`, `nemoclaw/src/commands/`
   - `Sandbox` → `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/`
   - `OpenShell` → cross-repo (lives at `github.com/NVIDIA/OpenShell`, not in this repo). Skip the +25 signal for OpenShell-only issues; cross-repo `git log` is out of v1 scope.
   - `Docker` → `Dockerfile`, `Dockerfile.base`, `scripts/install-openshell.sh`, `scripts/install.sh`
   - `Getting Started` → `docs/`, `scripts/install.sh`
   - `Integration: <X>` — no `src/lib/integrations/` exists in this repo. Skip the +25 signal for integration-component issues unless source 1 (file paths in body) yielded a path.
3. **Title keywords.** "policy" → `nemoclaw-blueprint/policies/`, `nemoclaw/src/blueprint/`. "inference" → `docs/inference/` is docs-only; skip the +25 signal unless source 1 surfaces actual code paths.

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

**Baseline-validation gating.** The +50 weight assumes the reproducer was *validated* — i.e., it produced the bug symptom on baseline (Step 8b/8c match). If `BASELINE_INSTALL_FAILED=1` (Step 8a fall-through, baseline pass skipped — including the sandbox-build-rot case from Step 11), the +50 still applies but **cap the total at 84**. Corroboration signals (commits-touched-area, PR-mention) still raise the score within the cap but cannot lift it above 84. Without runtime baseline confirmation we don't have enough on our own to claim ≥85 — the cap forces the verdict into the 60–84 band where the reporter is asked to confirm. The previous draft of this rule had an "unless commits-touched OR PR-mention also fires" escape hatch that let inferred fix evidence bypass the cap entirely; that produced a misleading 100/100 on the #2007 e2e run despite zero baseline confirmation, and was tightened here.

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

**HTML → text pre-pass for issue body excerpts.** NV QA bodies are HTML; tokens nested in `<pre>` tags or HTML attributes (e.g. `<a href="https://user:tok@host/...">`) slip past the regex patterns below if the input still has tags. Convert to plain text first, then redact:

```bash
TEXT=$(printf '%s' "$BODY_EXCERPT" | python3 -c '
import html, re, sys
b = sys.stdin.read()
b = re.sub(r"<br\s*/?>", "\n", b)
b = re.sub(r"</?(p|div|tr|td|th|li|pre)[^>]*>", "\n", b)
b = re.sub(r"<[^>]+>", "", b)
print(html.unescape(b))
')
# Now apply the regex table below to $TEXT.
```

Transcripts and synth-repro scripts are already plain text and skip the pre-pass.

**Order matters and the patterns below are in execution order.** Longest, most-specific patterns first; generic catchalls last. Otherwise the catchall masks specific matches and you lose track of what was actually redacted (JWT vs session blob vs random base64).

Patterns live in a fenced block (not a markdown table) because patterns 8 and 9 use regex alternation `|` — markdown tables would treat the literal `|` as a column delimiter, and escaping it as `\|` makes the regex match a literal pipe instead of an alternation, which silently breaks credential redaction.

```regex
1.  eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
    → JWT tokens

2.  gh[pousr]_[A-Za-z0-9]{36,}
    → GitHub PATs / install tokens

3.  (?i)nvapi-[A-Za-z0-9_-]{20,}
    → NVIDIA API keys (NIM / build.nvidia.com)

4.  AKIA[0-9A-Z]{16}
    → AWS access key IDs

5.  (?i)aws_secret_access_key\s*=\s*\S+
    → AWS secret keys

6.  (?i)authorization:\s*\S+
    → HTTP auth headers (often Bearer + JWT)

7.  URLs containing `@` before the host (e.g., https://user:pw@host/...)
    → Basic-auth credentials in URLs

8.  (?i)(token|secret|password|api[_-]?key|bearer)[^\n]*[:=][^\n]*
    → Inline credentials in env/config/log output

9.  \b\w+\.(nvidia\.internal|nv-internal\.com|nvidia\.dev)\b
    → Internal hostnames (extend list per team)

10. [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
    → Email addresses (PII)

11. \b[A-Za-z0-9+/]{60,}={0,2}\b
    → Long base64 blobs (likely keys/sessions; tune length to taste — too short hits legit data)
```

**File paths under the reporter's home directory** (`/Users/<name>/`, `/home/<name>/`) → replace with `~/`. Run last; catches incidental username PII.

**Comment authoring principle.** Every section in a rendered comment must either change a reader's mind about the verdict, or be cut. Word counts follow from that — **300 is a hard ceiling** for the main verdicts (fixed-on-latest, wontfix). Simple cases (clear PR ref, deterministic check) land under 200. The principle generalizes: comments posted by this skill compete for a maintainer's attention against every other in-flight thread, and "AI-slop" prose — architectural sidebars, file:line citations the maintainer can find via the PR ref, bare-output reproductions when the load-bearing evidence is elsewhere, "if this verification is wrong, please reopen…" boilerplate — actively reduces the comment's signal-to-noise ratio.

**For each section in a draft, ask: would the maintainer reach a different conclusion *without* this section? If no, delete.** Lessons accumulated from real runs:

- **#2007 first draft (~750 words):** had a multi-paragraph "Architectural notes for QA reference" section that didn't change the verdict. Cut → 371 words.
- **#2604 first three drafts:** wavered between fixed-on-latest, still-reproduces, and by-design across iterations because each draft padded the verdict with prose that didn't ground it. Final 190-word draft cut a maintainer-note sidebar about platform attribution, a bare-status output reproduction, and a file:line citation of the source — none affected the verdict, all were AI-slop padding. Rule learned: **before drafting any prose, name the verdict in one sentence; if a section doesn't directly support that one sentence, cut it before writing it.**

**Per-verdict length defaults:**

| Verdict | Target | Rationale |
|---|---|---|
| `fixed-on-latest` | **200–300 words** | Header + evidence + verdict + @-mention. Add hardware-substitution caveat or related-failure-mode section only if they shift the maintainer's read. If you're past 300, you're padding. |
| `wontfix` (by-design) | **200–300 words** | Structurally-fixed + vestigial + what's-not-the-same-bug, each one to two sentences max. The PR ref carries the detail; the comment carries the verdict. |
| `verify-inconclusive` | 100–200 words | One paragraph naming what the skill couldn't establish. No transcripts beyond a single quoted line. |
| **Still-reproduces (no label)** | **30–80 words** | The reporter already has the symptom; the maintainer can see the issue is open. The skill is just confirming + setting the TTL marker. **No transcripts** (the issue body has them), **no @-mention** (the reporter knows their bug is real), **no architectural prose**. One sentence stating "skill ran reproducer on `<latest>`, symptom still present" + one sentence on any partial-fix PR if relevant + marker. That's it. |

**Cut, by default:**

- Maintainer-note sidebars about labels / platform attribution unrelated to the bug surface.
- Bare-output reproductions when the load-bearing evidence is in a different command's output.
- File:line citations of source code already findable via the cited PR.
- Closing "if this verification is wrong, please reopen…" boilerplate.
- Redundant verbal framing of what the evidence already shows ("the table above proves…").
- "Verification mode" pleasantries beyond one factual line.

**Mandatory cap caveat.** When the score is capped (Step 9 baseline-validation gating, or any Step 11 degraded-mode path), the rendered Verdict section must include a one-line caveat naming the cap and the reason. Example: `Capped at 84 because Step 9's baseline-validation gate did not run (sandbox-build rot on v0.0.18: Dockerfile symlink layer removed by #2227).` Don't make readers reverse-engineer why the score didn't go higher — name it.

**Mandatory hardware-substitution caveat.** When the issue carries `Platform: DGX Spark` or `Platform: GB10` and Step 7 provisioned a Brev SKU that is not the same silicon (Brev's stoppable GPU catalog is x86 + discrete H100/A100/L40S/T4 — not Grace Hopper / GB10 unified-memory ARM64), the rendered comment must include a one-line "Hardware substitution" note. Example: `Hardware substitution: verified on Brev n1-standard-4:nvidia-tesla-t4 (x86_64 + T4) as a substitute for the reporter's DGX Spark (ARM64 + GB10). For silicon-shape bugs (perf, memory architecture, drivers) this is not a faithful repro — please confirm on actual DGX Spark.` This goes in the metadata block right after `Verification mode:` so it's visible at the top, not buried in the analysis.

**Mandatory `Verification mode` header line.** All three templates below include a `**Verification mode:**` line in the metadata block, naming what we did and didn't actually run (e.g., "runtime reproduction on Brev <SKU>; baseline + latest both installed and run" for the standard template; "static analysis at the verified-on tag — no runtime reproduction" for the by-design template; "runtime reproduction on Brev <SKU>; bug confirmed live on latest" for still-reproduces). Reader should never have to guess whether the verdict came from real install logs or from static analysis.

**Link-pass self-verification (all templates).** Same rule as Step 8.5d's link pass, applied to every template. Resolve at least one rendered markdown link from each section that has them (`What's structurally fixed` / `Vestigial references` / `Existing CI coverage` for by-design; `Relevant changes since` / transcript code-anchor citations for the standard template) via `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=<tag>` (returns 200 + base64 if path exists at tag, 404 otherwise) or `curl -fsI <blob-url>`. A 404 on a citation in the rendered comment is worse than no citation — it advertises verification work that didn't actually happen. If any link fails to resolve, fix it or bail to `verify-inconclusive`.

**Mandatory closing block — reporter @-mention with confirmation language.** Every template below **except `Still-reproduces`** ends with an explicit @-mention of the original reporter using this exact shape:

> @\<reporter\> — please confirm the symptom is gone on a recent build (≥ v0.0.\<Z\>) and reopen with a fresh reproducer if you observe otherwise.

The skill cannot independently confirm a closed-as-fixed verdict — only the reporter knows whether their original symptom is gone in their environment. The @-mention is what converts a "skill says it's fixed" claim into actionable confirmation work for QA. Customize `<Z>` per case (the version that shipped the fix or `$LATEST`), but never omit the line.

**Mandatory unanswered-question prefix and dual @-mention.** When Step 3 sets `UNANSWERED_MAINT_LOGIN` (a maintainer's question is older than 7 days and the reporter never replied), the verdict comment changes shape in two places:

1. **Prepend a lead paragraph** as the very first line of the body, before the `## Stale-issue verification` heading. The lead paragraph is a single line:

   ```text
   [@UNANSWERED_MAINT_LOGIN's comment](UNANSWERED_MAINT_URL) from UNANSWERED_MAINT_DATE is still unanswered. Posting independent verification below to unstick the thread.
   ```

   …with the bracketed variables expanded from the values exported by Step 3.

2. **Replace the closing reporter-only @-mention with a dual @-mention** that names BOTH the maintainer (acknowledging the open question) and the reporter (per the standard confirmation pattern):

   > @\<UNANSWERED_MAINT_LOGIN\> — flagging that your question above is still open; the verification below may answer it. @\<reporter\> — please confirm the symptom is gone on a recent build (≥ v0.0.\<Z\>) and reopen with a fresh reproducer if you observe otherwise.

This applies to all three templates (fixed, still-reproduces, by-design). The skill becomes the *unsticking voice* on a thread that has gone quiet — never a clueless interruption when discussion is fresh (Step 3 already filtered the within-7-day case).

**Comment template (fixed / inconclusive — bug not reproduced on latest):**

````markdown
## Stale-issue verification — automated

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Verification mode:** runtime reproduction on Brev `<instance-class>` — baseline (v0.0.31) and latest (v0.0.34) both installed and run; comparison made on the captured transcripts. (Or: "runtime reproduction on Brev `<instance-class>` — baseline-install-skipped (`.openclaw-data` rot, see Step 11), latest-only run; verdict capped at 84.")
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

@<reporter> — please confirm the symptom is gone on a recent build (≥ v0.0.<Z>) and reopen with a fresh reproducer if you observe otherwise.

<!-- nemoclaw-verify-stale v1 2026-05-12 -->
````

**Comment template (still reproduces — Step 9 special case):**

````markdown
## Stale-issue verification — still reproducible

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Verification mode:** runtime reproduction on Brev `<instance-class>` — baseline confirmed the symptom matches the issue; latest (v0.0.34) also produced the symptom. Bug is still live.
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04

The skill ran the reported reproducer on v0.0.34 and observed the same bug symptom described in this issue. The bug is still live.

No label applied. Will re-verify automatically next weekly run; if a fix lands in the interim, the next pass catches it.

@<reporter> — please confirm the symptom still matches your observation on v0.0.<Y> and reopen with any updated reproducer or environment details if it has shifted.

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

**Pre-post state-check.** A long-running verification can race with the maintainer closing the issue independently — happened on #2513 and #2519 (mid-batch closes by @jyaunches with their own verification). Re-check `state == OPEN` right before posting. If closed, apply the label tag-only (skipping the comment, since the maintainer's own close-comment is now the authoritative record) and skip the Project 199 move.

```bash
STATE=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json state --jq .state)
if [ "$STATE" != "OPEN" ]; then
  echo "[verify-stale] #$ISSUE_NUMBER closed since verification started — applying label tag-only, skipping comment + tracker move"
  gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "$LABEL"
  exit 0
fi
```

**Post the comment and apply the label:**

```bash
gh issue comment "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --body-file comment.md
gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "fixed-on-latest"
# or for <60:
# gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "verify-inconclusive"
```

**Move the issue to "Needs Review" on the NemoClaw Development Tracker AND self-assign (only on `fixed-on-latest`).** The tracker is GitHub Project [NVIDIA/199](https://github.com/orgs/NVIDIA/projects/199) ("NemoClaw Development Tracker"). When the skill's verdict is `fixed-on-latest`, the issue moves to **Needs Review** AND the issue is assigned to the maintainer who ran the skill (`$GH_IDENTITY` from Step 6.5) — assignment puts the issue in their personal review queue so they don't lose track of what they've staked their name on. After the reporter confirms and the maintainer closes, existing Project automation (or a manual move) advances it to Done. **No move and no assign on `wontfix` / `verify-inconclusive` / no-label-still-reproduces** — those have separate close paths.

This step requires the `project` scope on the maintainer's gh CLI (`gh auth refresh -h github.com -s project` in a real terminal once; OAuth device-code flow). If the scope is missing, the lookup query returns an auth error — fall through with a one-line warning rather than failing the whole run.

```bash
# Project 199 constants (re-run gh project field-list 199 --owner NVIDIA --format json
# if the project gets renamed/restructured and these IDs drift):
PROJECT_ID="PVT_kwDOABpemM4BSCP5"
STATUS_FIELD_ID="PVTSSF_lADOABpemM4BSCP5zg_r9p8"
NEEDS_REVIEW_OPTION_ID="5c5922a9"

# Only fire on fixed-on-latest. Skip silently otherwise.
if [ "$VERDICT" = "fixed-on-latest" ]; then
  # Find the issue's existing project item, if any.
  ITEM_ID=$(gh api graphql -f query='
    query($num: Int!) {
      repository(owner: "NVIDIA", name: "NemoClaw") {
        issue(number: $num) {
          projectItems(first: 10) {
            nodes { id project { number } }
          }
        }
      }
    }' -F num="$ISSUE_NUMBER" \
    --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number == 199) | .id' \
    2>/dev/null | head -1)

  # If the issue isn't on the project yet, add it. (NV QA bots usually add new
  # issues automatically, but cover the gap.)
  if [ -z "$ITEM_ID" ]; then
    ITEM_ID=$(gh project item-add 199 --owner NVIDIA \
      --url "https://github.com/NVIDIA/NemoClaw/issues/$ISSUE_NUMBER" \
      --format json --jq .id 2>/dev/null)
  fi

  if [ -n "$ITEM_ID" ]; then
    gh project item-edit \
      --id "$ITEM_ID" \
      --project-id "$PROJECT_ID" \
      --field-id "$STATUS_FIELD_ID" \
      --single-select-option-id "$NEEDS_REVIEW_OPTION_ID" \
      >/dev/null && echo "[verify-stale] moved #$ISSUE_NUMBER to 'Needs Review' on Project 199"
  else
    echo "[verify-stale] WARN could not resolve project item for #$ISSUE_NUMBER on Project 199 — label applied but tracker not moved"
  fi

  # Self-assign the issue to the maintainer who ran the skill — puts it in their
  # personal review queue alongside the Needs Review state.
  gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-assignee "$GH_IDENTITY" \
    >/dev/null && echo "[verify-stale] assigned #$ISSUE_NUMBER to @$GH_IDENTITY"
fi
```

The Step 12 activity log line should record the project move (or the warn-and-skip case) so a maintainer scanning the log can spot tracker drift. Add a `Tracker:` row to the per-issue entry: `Tracker: moved to Needs Review` | `not moved (verdict: <X>)` | `not moved (project lookup failed)`.

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
- Step 9 applies the score cap (max 84) — corroboration signals raise the score within the cap but cannot lift past it.
- Note "baseline-install-skipped" in the final comment so a reviewer knows the verification ran without the script-validation gate.

**Baseline-build failure** (Step 8a binary install succeeded, but the in-image `Dockerfile` build during sandbox creation failed on a layer that was structurally removed in a later release): also degraded mode, distinct from binary install rot. Surfaced during the #2007 e2e run on v0.0.18 (`/sandbox/.openclaw-data/workspace/media` symlink layer, removed entirely by #2227).

- Set `BASELINE_INSTALL_FAILED=1` (same flag — Step 9's cap-at-84 rule keys off it regardless of which phase rotted).
- Skip 8b/8c, jump to 8d.
- Note "baseline-build-skipped" in the final comment with the specific failing layer/file so a reviewer can see *why* the v0.0.X image no longer builds (the why is usually a follow-on PR that removed the rotted layer).
- Do not retry the build with a patched Dockerfile — that breaks faithfulness. We're claiming "couldn't independently re-trigger the original symptom on baseline," not "we made the old version work somehow."

Both baseline-rot variants share the same downstream effect: Step 9 cap, Step 10 caveat, @-mention reporter to confirm. Distinguishing them in the comment helps a reviewer understand the failure mode without re-running.

This degradation is expected — old releases rot at multiple phases (binary installer URL drift, base-image dependencies vanish, in-image Dockerfile layers get removed by structural refactors). We still want to extract whatever signal we can from the latest run plus PR/commit evidence, just at a more conservative confidence ceiling.

**Empirical reality after two e2e runs:** baseline-build-rot is the **dominant** failure mode for any reported version more than ~5–7 patches behind, not an edge case. Both #2007 (v0.0.18, 17 patches behind) and #2592 (v0.0.28, 7 patches behind) hit it. The cap-at-84 with reporter @-mention is the **modal** verdict shape for stale-issue verification, not the exception. Reframe expectations accordingly:

- For issues reported >5 patches behind `$LATEST`, plan for the cap-at-84 path. Pre-flight (PR-search, pickaxe) carries more weight than baseline runtime evidence.
- For issues reported within 1–4 patches of `$LATEST`, baseline is more likely to install cleanly and the full +50 path is reachable.
- The skill's design assumes baseline + latest both run cleanly; in practice latest-only with cap-at-84 is the workhorse path. The score-cap is doing real work, not just a fallback.

**Keep-box-on-inconclusive.** When `verify-inconclusive` lands (Step 8c gave up, or Step 9 score < 60), **skip the cleanup trap** for this run if the box was provisioned by this run — set `PROVISIONED_NEW=0` before the trap fires so the EXIT handler is a no-op. Print the `brev shell "$INSTANCE_NAME"` command and an explicit `brev delete "$INSTANCE_NAME"` reminder in the run output so the maintainer can triage and clean up manually. Reused boxes stay regardless. Ship-failed verifications are the exact case where having an inspectable artifact pays for itself; an unbounded sleep-and-delete in the background isn't reliable across session ends, so we leave deletion explicit.

---

## Step 12: Log to Activity

After each issue (verified, inconclusive, by-design, or infra-failed), append to `${VERIFY_STALE_LOG_DIR:-$HOME/development/daily-rhythm/activity}/nemoclaw-verify-stale-log.md`. The default path matches the personal-organizer convention; export `VERIFY_STALE_LOG_DIR` to point elsewhere (CI, shared volume, etc.). Create the directory if missing — do not assume it exists.

```markdown
### NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Environment:** CPU | GPU (<instance type>)
**Box:** reused <name> | provisioned <name> | local (no Brev — Step 6.7 short-circuit)
**Baseline install:** succeeded | failed (degraded mode)
**Baseline match:** validated (verbatim) | validated (synth) | failed (verify-inconclusive) | skipped
**Latest install:** succeeded | failed (infra error)
**Latest result:** not-reproduced (clean) | still-reproduces | partial / flake | n/a (skipped 8d)
**Confidence:** 88 / 100 | n/a (still-reproduces)
**Label applied:** fixed-on-latest | verify-inconclusive | status: wont-fix | none (still-reproduces) | none (infra)
**Tracker:** moved to Needs Review on Project 199 | not moved (verdict: <X>) | not moved (project lookup failed)
**Assignee:** @<GH_IDENTITY> | not assigned (verdict: <X>)
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
**Marked `status: wont-fix` (by-design path):** N
**Marked `verify-inconclusive`:** N
**Local-first short-circuits (no Brev cost):** N
**Skipped (Windows / macOS / integration / no version):** N
**Infra failures:** N
**Brev wall time:** N min · approx $X.XX

---
```

Never stage or commit the log to the NemoClaw repo.

---

## Cadence

- **Weekly cron** — Monday morning, batch mode, ≤15 issues (the Step 1 cap, sliced after Step 3/4 filters).
- **Manual** — invoke with a single issue number anytime.

---

## Out of Scope (v1)

- Auto-closing issues. Always tag-only; a human pulls the trigger.
- macOS verification *via the Brev path*. Brev offers no macOS instances. The Step 6.7 local-first short-circuit *does* run on a maintainer's macOS laptop — so manual single-issue runs against pure-CLI bugs work on macOS. The weekly batch cron is Linux-only because that path always uses Brev.
- Issues requiring third-party integration credentials (Slack, Discord, Telegram, Hermes, OpenClaw, WeChat).
- Service-account bot identity. v1 runs under each maintainer's own GitHub credentials.
- Versioned labels. A single `fixed-on-latest` label is swept on each release cut.

---

## Companion Behavior

`nemoclaw-maintainer-cut-release-tag` sweeps `fixed-on-latest` and `verify-inconclusive` from all open issues at release time. Without that sweep, "latest" drifts and verifications go stale silently. The by-design path uses the existing repo `status: wont-fix` label; that label is **not** swept (it's also applied for non-skill reasons such as scope or priority decisions, and clearing it would erase human triage work).
