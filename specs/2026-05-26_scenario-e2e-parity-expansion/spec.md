<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Specification: Scenario E2E Parity Expansion

## Overview & Objectives

The hybrid scenario E2E architecture defines a cleaner framework for composing scenarios, onboarding manifests, assertion modules, and phase orchestrators. This second specification expands that architecture so the scenario suite can represent the semantic behavior of the legacy top-level E2E scripts, not only the existing validation-suite metadata.

The source audit is:

```text
specs/2026-05-26_hybrid-scenario-e2e-architecture/current-main-e2e-coverage-audit.md
```

This spec uses two sections from that audit as its source of truth:

1. **Top-level E2E assertion audit** — each `test/e2e/test-*.sh` script's concrete assertions and recommended typed owner.
2. **Setup and onboarding manifest parity audit** — the environment setup, onboarding manifest, fixtures/data, and setup parity notes required to drive equivalent assertions.

The goal is to make it clear, phase by phase, what must be added to the scenario framework so a coding agent cannot claim parity by registering metadata only.

### Objectives

- Add scenario contracts for every top-level legacy E2E behavior that remains in scope.
- Separate product-facing onboarding manifests from E2E-only environment setup, fixtures, runtime actions, and assertions.
- Extend manifests only where durable desired NemoClaw instance state is missing.
- Add fixture and runtime-action structures for setup that is not product manifest state.
- Implement real live or hermetic assertions that touch the same system boundary as the legacy scripts.
- Track parity statuses with enough precision to prevent dry-run/preview output from counting as coverage.

### Non-goals

- Do not delete legacy `test/e2e/test-*.sh` scripts in this spec.
- Do not include any PR CI loop or `/skill:nemoclaw-pr-ci-loop` workflow in this spec.
- Do not force host-only or installer-only tests into `NemoClawInstance` manifests.
- Do not store raw secrets, fake secret literals, assertion IDs, or suite composition in product-facing manifests.
- Do not count dry-run/preview/compiled-plan output as semantic parity.

## Current State Analysis

The hybrid architecture already introduces typed scenario builders, manifests, assertion modules, phase orchestrators, clients/adapters, and a preview/plan capability. The current gap is that the scenario suite primarily represents the old validation-suite layer. It does not yet represent the full setup and behavior of the top-level E2E scripts.

The current manifest/scenario shape supports:

- Basic platform/install/runtime dimensions: Ubuntu, macOS, WSL, GPU, Brev, repo-current, public-curl, launchable, Docker running/missing/optional.
- Basic onboarding identity: agent, provider, model, inference route, simple policy presets, one messaging provider, and coarse lifecycle labels.
- Basic negative cases where the failure vocabulary already exists.

It is not sufficient for full setup parity because legacy top-level E2E scripts require:

- multi-channel messaging matrices;
- post-onboard lifecycle operations such as `channels add`, `channels stop`, `rebuild`, `inference set`, `snapshot`, `tunnel start`, and `shields up`;
- host-only and hermetic tests with no NemoClaw instance;
- fake providers, old base images, bad-key fixtures, port holders, crash shims, Docker daemon mutations, `/etc/hosts` edits, registry/session staging, and marker files;
- richer environment/tool requirements such as passwordless sudo, `cloudflared`, `jq`, `expect`, GPU driver/Ollama model pulls, fixed ports, and dev dependencies;
- richer expected-failure classes such as invalid NVIDIA key, gateway port conflict, unreachable endpoint, image/schema drift, and gateway crash behavior.

## Architecture Design

### Scenario contract model

Every parity scenario must be defined by a five-part contract:

| Contract part | Purpose | May contain | Must not contain |
|---|---|---|---|
| `environment` | Host/runner setup needed before onboarding or fixture actions | OS, runner labels, Docker/GPU/sudo/tool/network/port requirements, required secrets, skip/transient classifiers | assertion pass/fail logic |
| `manifest` | Product-facing desired NemoClaw instance state | install source, runtime intent, agent, provider, model/route, policy tier/presets, channels, credential refs, durable lifecycle intent | raw secrets, fake bad keys, assertion IDs, top-level script names |
| `fixtures` | E2E-only setup needed to recreate legacy conditions | fake services, old images, port holders, monkeypatches, staged state, marker files, daemon mutations, policy patches, cleanup obligations | durable product desired state |
| `runtimeActions` | Ordered operations after environment/onboarding and before assertions | `channels add`, `channels remove`, `inference set`, `snapshot create`, `rebuild`, `tunnel start`, `shields up/down`, gateway kill/restart | generic metadata-only mappings |
| `assertions` | Real semantic checks | stable assertion IDs, live/hermetic SUT interactions, evidence paths, retry/timeout policy | dry-run-only checks as parity |

### Parity status vocabulary

Use these statuses in parity inventory and reports:

| Status | Meaning | Counts as parity? |
|---|---|---|
| `mapped-live` | A scenario executes a real sandbox/provider/network/product path and verifies the same observable behavior. | Yes |
| `mapped-hermetic` | A scenario uses fake services or synthetic clients but executes the real product code path and verifies the same behavior. | Yes |
| `partial` | Related coverage exists, but weaker or narrower than the legacy assertion. | No |
| `metadata-only` | Scenario/manifests/assertion IDs are registered but no equivalent SUT interaction exists. | No |
| `retired` | Intentionally dropped with rationale. | Yes, only with rationale |
| `deferred` | Not yet implemented or intentionally out of the current wave. | No |

Rules:

- Dry-run, preview, or compiled-plan output may validate discoverability and wiring only.
- No legacy assertion may move to `mapped-live` or `mapped-hermetic` without a real assertion implementation and setup contract.
- `pendingStep(...)`, no-op probes, and generic health checks cannot replace behavior-specific assertions.
- If a behavior is intentionally not ported, mark it `retired` with a rationale and reviewer-visible evidence.

### Required framework extensions

Extend the active scenario framework in place under the existing `test/e2e/` layout before porting large script families:

```text
test/e2e/
  nemoclaw_scenarios/
    scenarios.yaml              # environment/install/runtime/onboarding dimensions and contract references
    expected-states.yaml        # reusable expected state contracts
    fixtures/                   # fixture setup/teardown implementations
    runtime-actions/            # new post-onboard operation primitives, if a shared helper is needed
    manifests/                  # optional product-facing NemoClawInstance manifests when durable state needs standalone YAML
  validation_suites/
    suites.yaml                 # ordered assertion suites and requires_state predicates
    assert/                     # reusable assertion helpers with stable PASS/FAIL IDs
    <domain>/                   # domain-specific assertion steps
  runtime/
    resolver/                   # contract schema, validation, plan, coverage, and parity inventory logic
    reports/                    # deterministic report renderers
  docs/                         # scenario model, migration, and generated parity inventory docs
```

Do not create a parallel `test/e2e-scenario/`, `test/e2e/scenarios/`, or workflow-only parity tree unless the active framework has already moved there before implementation begins.

### Product manifest shape

Product-facing manifests should continue toward this shape:

```yaml
apiVersion: nemoclaw.io/v1
kind: NemoClawInstance
metadata:
  name: openclaw-nvidia
spec:
  setup:
    install:
      source: repo-current
    runtime:
      containerEngine: docker
      containerDaemon: running
    platform:
      os: ubuntu
      executionTarget: local
  onboarding:
    agent: openclaw
    provider: nvidia
    modelRoute: inference-local
    model: nvidia/nemotron-3-super-120b-a12b
    policyTier: balanced
    policyPresets: []
    channels: []
  state:
    credentialRefs:
      - NVIDIA_API_KEY
```

Manifest expansion needed by this spec:

- multiple channels, not a single `messaging` scalar;
- credential refs per provider/channel;
- explicit install source when public-curl, launchable, upgrade, or build-provider flows matter;
- explicit policy tier/presets and optional channel policy intent;
- optional durable lifecycle intent such as `resume-after-interrupt`, `token-rotation`, `rebuild-from-old-agent`, or `tunnel-start-stop`, while keeping test mechanics in fixtures/runtime actions;
- optional platform/runtime hints for GPU, launchable, Spark, or Docker-missing cases.

### Fixture and runtime action model

Fixtures must be explicit, typed, and independently testable. Examples:

```ts
fixture("fake-openai-endpoint").port("NEMOCLAW_FAKE_PORT").provides("/v1/chat/completions");
fixture("legacy-credentials-json").writesHomeState().cleanupRequired();
fixture("old-openclaw-base-image").version("2026.3.11").cleanupRequired();
runtimeAction("channels.add", { channel: "telegram" });
runtimeAction("inference.set", { provider: "nvidia-prod", model: "z-ai/glm-5.1" });
```

Acceptance requirements:

- Fixture setup and teardown must emit evidence.
- Dangerous fixtures such as Docker daemon mutation, `/etc/hosts` edits, temporary policy mutation, and blueprint mutation must include restore/cleanup obligations.
- Runtime actions must be ordered and visible in scenario preview/results.
- Assertion modules must declare which fixture outputs and runtime-action outputs they require.

## Configuration & Deployment Changes

No production deployment behavior changes are required. E2E-only configuration changes include:

- new scenario manifests under the scenario-suite manifest directory;
- new fixture modules for fake services and staged state;
- new runtime-action modules for post-onboard lifecycle operations;
- expanded expected-failure vocabulary;
- expanded parity inventory statuses;
- workflow target updates only as needed to call canonical scenario IDs.

New environment variables should be grouped and documented by scenario contract rather than scattered through assertion scripts. Existing variables from legacy scripts may remain supported during migration, but scenario contracts must define the canonical names.

## Implementation Phases

### Required implementation workflow for every phase

Each phase must follow this order so parity cannot be claimed before real behavior exists:

1. **Inventory first:** add or update parity inventory rows for every legacy script/assertion assigned to the phase, with owner, source audit reference, initial status, and no complete-parity claim.
2. **Failing tests next:** add contract validation and domain-specific tests that fail for missing setup, missing assertion modules, placeholder steps, weak generic probes, and incomplete script coverage.
3. **Primitives before mappings:** implement reusable fixtures, runtime actions, and assertion helpers in the existing scenario framework paths before wiring many scenarios to them.
4. **Scenario wiring:** connect scenario metadata, expected state, suite steps, fixture dependencies, runtime action ordering, and assertion modules.
5. **Evidence before status upgrade:** update a parity entry to `mapped-live` or `mapped-hermetic` only after the executable assertion module emits stable assertion IDs and evidence paths for every required behavior.
6. **Phase closeout:** mark the phase complete only after every assigned row is `mapped-live`, `mapped-hermetic`, or `retired` with rationale; any `partial`, `metadata-only`, or `deferred` row keeps the phase open.

## Phase 1: Parity Contract Foundation [COMPLETED: 3e3873351]

### Audit sections covered

- `current-main-e2e-coverage-audit.md` high-priority parity gates.
- `current-main-e2e-coverage-audit.md` setup/manifest support assessment.
- All setup parity rows at a metadata level, without claiming semantic mapping.

### Required expansion

- Add scenario contract types for `environment`, `manifest`, `fixtures`, `runtimeActions`, and `assertions`.
- Add parity statuses: `mapped-live`, `mapped-hermetic`, `partial`, `metadata-only`, `retired`, `deferred`.
- Add tests that fail if a legacy assertion is marked mapped by dry-run/preview/metadata alone.
- Add a report that shows, for each legacy script, which scenario contracts cover environment setup, manifest, fixtures, runtime actions, and assertions.
- Add expected-failure vocabulary for at least:
  - `invalid-nvidia-api-key`
  - `gateway-port-conflict`
  - `unreachable-compatible-endpoint`
  - `gateway-schema-drift`
  - `stale-gateway-image`
  - `gateway-start-crash`

### Acceptance criteria

- A scenario can be previewed without side effects, but preview output is labeled `metadata-only` for parity purposes.
- Inventory validation fails if any `mapped-live` or `mapped-hermetic` entry lacks a real assertion step and setup contract.
- Inventory validation fails if a `retired` entry lacks rationale.
- Existing scenario metadata tests still pass.

## Phase 2: Environment, Manifest, Fixture, and Runtime Action Primitives [COMPLETED: e44d347ac]

### Audit sections covered

- All rows in `Setup and onboarding manifest parity audit` as infrastructure requirements.
- Top-level scripts that are setup-heavy but assertion-light:
  - `test-gateway-drift-preflight.sh`
  - `test-gateway-health-honest.sh`
  - `test-openshell-version-pin.sh`
  - `test-onboard-inference-smoke.sh`
  - `test-docs-validation.sh`
  - `test-ollama-auth-proxy-e2e.sh`

### Required expansion

Add reusable primitives for:

- fake service lifecycle: OpenAI-compatible, Bedrock-compatible, Kimi, Discord Gateway, Slack API, Telegram, model router;
- fake CLI/client fixtures: fake OpenShell, fake Docker, fake installer/download tools;
- state staging: `~/.nemoclaw/sandboxes.json`, `onboard-session.json`, legacy `credentials.json`, provider records;
- port holders and port probes;
- old image fixtures for OpenClaw/Hermes/rebuild/upgrade;
- crash shim fixture for `openshell-gateway`;
- setup-only and host-only scenario type where no `NemoClawInstance` manifest is required;
- runtime action runner with ordered evidence.

### Acceptance criteria

- Host-only/hermetic scenarios do not require fake product manifests.
- Fixture setup and teardown are tested without requiring live cloud secrets.
- Dangerous fixtures include cleanup/restore tests.
- `test-gateway-drift-preflight.sh`, `test-gateway-health-honest.sh`, `test-openshell-version-pin.sh`, and `test-onboard-inference-smoke.sh` can be represented as hermetic scenario contracts with real assertions.

## Phase 3: Onboarding and Installer Parity [COMPLETED: 4f152818f]

### Audit sections covered

From `Top-Level E2E Scripts 00-14` and `30-44`:

- `test-full-e2e.sh`
- `test-cloud-onboard-e2e.sh`
- `test-cloud-inference-e2e.sh`
- `test-double-onboard.sh`
- `test-onboard-negative-paths.sh`
- `test-onboard-resume.sh`
- `test-onboard-repair.sh`
- `test-launchable-smoke.sh`
- `test-spark-install.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-nvidia.yaml`
- `openclaw-nvidia-public-curl.yaml`
- `openclaw-nvidia-cloud-inference.yaml` if explicit model parity is needed
- `openclaw-openai-compatible-double-onboard.yaml`
- `openclaw-nvidia-invalid-key-negative.yaml`
- `openclaw-nvidia-gateway-port-conflict.yaml`
- `openclaw-nvidia-custom-policies.yaml`
- `openclaw-nvidia-resume-after-interrupt.yaml`
- `openclaw-nvidia-repair-existing-config.yaml`
- `launchable-cloud-nvidia-openclaw.yaml`
- `dgx-spark-install-only.yaml` or an explicit setup-only scenario without a product manifest

### Required fixtures/runtime actions

- public installer source/ref/log verification;
- fake OpenAI endpoint for double-onboard;
- port-holder fixture for gateway port conflict;
- bad-key fixture injected by scenario, not stored in manifest;
- interrupted session fixture for resume/repair;
- missing recorded sandbox fixture for repair;
- launchable clone/sentinel fixture;
- direct cloud, sandbox route, and OpenClaw-mediated prompt payloads.

### Required assertions

- install source/ref correctness;
- CLI/OpenShell availability;
- direct NVIDIA chat, sandbox `inference.local` chat, and OpenClaw-mediated agent response as distinct assertions;
- gateway reuse and no port conflicts during double-onboard;
- stale registry reconciliation and lifecycle guidance;
- resume cached-step skipping and session completion;
- repair recreates missing recorded sandbox and rejects conflicting resume requests;
- launchable artifacts and sentinel readiness.

### Acceptance criteria

- Happy-path OpenClaw cloud onboarding is `mapped-live` only when all three inference surfaces are covered where required: direct provider, sandbox route, agent-mediated.
- Negative onboarding cases are `mapped-hermetic` or `mapped-live` only when they assert failure message, no stack trace, and forbidden side effects.
- Public installer and launchable setup cannot be satisfied by repo-current install manifests.

## Phase 4: Inference Provider, Routing, and Config-Shape Parity [COMPLETED: 2037fbe84]

### Audit sections covered

- `test-bedrock-runtime-compatible-anthropic.sh`
- `test-inference-routing.sh`
- `test-kimi-inference-compat.sh`
- `test-model-router-provider-routed-inference.sh`
- `test-openclaw-inference-switch.sh`
- `test-hermes-inference-switch.sh`
- `test-messaging-compatible-endpoint.sh`
- `test-runtime-overrides.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-bedrock-compatible-anthropic.yaml`
- `hermes-bedrock-compatible-anthropic.yaml`
- `openai-openclaw-routing.yaml`
- `anthropic-openclaw-routing.yaml`
- `compatible-openclaw-routing.yaml`
- `compatible-openclaw-kimi.yaml`
- `routed-nvidia-openclaw-model-router.yaml`
- `openclaw-nvidia-inference-switch.yaml`
- `cloud-nvidia-hermes-inference-switch.yaml`
- `telegram-compatible-openclaw.yaml`
- `openclaw-runtime-overrides.yaml` only as image-entrypoint setup if a product manifest is useful

### Required fixtures/runtime actions

- fake Bedrock Runtime endpoint and host mapping fixture;
- Bedrock adapter state/log/token fixture;
- fake compatible OpenAI/Kimi endpoints;
- model-router health endpoint fixture or live setup contract;
- inference switch runtime action for OpenClaw and Hermes;
- runtime override container/image fixture;
- provider-key leak scan fixture;
- trajectory/session artifact reader.

### Required assertions

- provider route identity and provider registry shape;
- OpenClaw and Hermes config shape after compatible provider setup;
- adapter health including fake endpoint, region, token hash;
- authenticated Converse/ConverseStream or compatible traffic observed by fake endpoint;
- sandbox route chat returns expected content;
- OpenClaw/Hermes runtime path returns expected content;
- Kimi trajectory splits combined tool calls into discrete `hostname`, `date`, `uptime` exec calls;
- model-router `healthy_count > 0` and routed completion returns `model: nvidia-routed*` plus content;
- inference switch updates route/session/registry/config without unwanted restart where legacy checked it;
- runtime overrides update config and config hash, and reject invalid values.

### Acceptance criteria

- Generic `/v1/models` health cannot satisfy provider-specific routing or config-shape assertions.
- Kimi compatibility is not mapped unless trajectory/tool-call semantics are asserted.
- Inference switch is not mapped unless route state, registry/session state, config hash/shape, and live post-switch request are covered.

## Phase 5: Local GPU and Ollama Parity [COMPLETED: e4ee216d4]

### Audit sections covered

- `test-gpu-e2e.sh`
- `test-gpu-double-onboard.sh`
- `test-ollama-auth-proxy-e2e.sh`

### Required manifest expansion

Add or verify manifests for:

- `local-ollama-openclaw-gpu-full.yaml`
- `local-ollama-openclaw-reonboard.yaml`
- optional host-only `host-ollama-auth-proxy.yaml` only if setup-only manifests are supported

### Required fixtures/runtime actions

- GPU runner environment contract with Docker CDI and `nvidia-smi`;
- Ollama install/start/model-pull fixture;
- Ollama auth proxy start/kill/restart fixture;
- persisted token file fixture and divergent token fixture;
- optional Docker container reachability probe.

### Required assertions

- sandbox status reports GPU enabled;
- install log contains GPU proof markers;
- Ollama host API reachable;
- proxy rejects unauthenticated/wrong token and accepts persisted token;
- token file exists with `600` permissions;
- proxy restart keeps token stable;
- re-onboard token matches live proxy;
- sandbox `inference.local` returns expected content after initial and repeated onboarding.

### Acceptance criteria

- Local Ollama parity is not mapped by cloud inference checks.
- Host-only auth proxy behavior is not forced into a sandbox scenario.
- GPU proof markers and token-divergence recovery have dedicated assertions.

## Phase 6: Messaging Channel Lifecycle Parity

### Audit sections covered

- `test-channels-add-remove.sh`
- `test-channels-stop-start.sh`
- `test-messaging-providers.sh`
- `test-token-rotation.sh`
- `test-telegram-injection.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-nvidia-telegram-channel-lifecycle.yaml`
- `openclaw-nvidia-all-channels.yaml`
- `hermes-nvidia-all-channels.yaml`
- `cloud-nvidia-openclaw-messaging-full-matrix.yaml`
- `openclaw-nvidia-messaging-token-rotation.yaml`
- `openclaw-nvidia-telegram-security.yaml`

Manifest model must support `channels: []` and `channels: [telegram, discord, slack, wechat, whatsapp]` rather than a single scalar.

### Required fixtures/runtime actions

- channel fake token/id environment fixtures;
- channel add/remove/stop/start runtime actions;
- rebuild runtime action;
- provider cache/state reader;
- full messaging policy premerge fixture for Slack first-boot parity;
- WhatsApp add/rebuild fixture;
- token A/B fixture for rotation phases;
- injection payload fixtures and proof-file cleanup.

### Required assertions

- baseline no-channel state before add;
- add/remove command output and rebuild result;
- policy preset state, agent config presence/absence, provider record state, egress probe;
- stop/start disabled channel registry state while provider cache remains;
- OpenClaw and Hermes-specific config mapping for all channels;
- provider credential hashes and changed-provider-only rebuild detection;
- same-token reuse does not rebuild;
- shell injection payloads do not execute and raw API key does not leak.

### Acceptance criteria

- One-provider messaging checks cannot satisfy full matrix parity.
- Token rotation is not mapped unless changed-provider isolation and same-token reuse are asserted.
- Channel lifecycle is not mapped unless post-onboard commands and rebuild effects are executed.

## Phase 7: Messaging Deep Agent Flow Parity

### Audit sections covered

- `test-hermes-discord-e2e.sh`
- `test-hermes-slack-e2e.sh`
- `test-openclaw-discord-pairing.sh`
- `test-openclaw-slack-pairing.sh`

### Required manifest expansion

Add or verify manifests for:

- `cloud-nvidia-hermes-discord.yaml`
- `cloud-nvidia-hermes-slack.yaml`
- `openclaw-nvidia-discord-pairing.yaml`
- `openclaw-nvidia-slack-pairing.yaml`

### Required fixtures/runtime actions

- fake Discord Gateway and capture fixture;
- fake Slack REST/WebSocket fixture;
- native WebSocket credential rewrite fixture;
- pairing request creation fixture;
- connect-shell approval runtime action;
- allowFrom store reader;
- no-allowlist setup for pairing-required paths.

### Required assertions

- Hermes health with channel enabled;
- Hermes Discord/Slack config and `.env` placeholder shape;
- provider records exist;
- fake gateway captures host token and not placeholder;
- raw token absent from config, env, process list, filesystem, and logs;
- Slack policy scoped to Hermes/Python or OpenClaw/Node as appropriate;
- pairing pending file contains code/user;
- approve consumes code, updates allowFrom, and second approval fails closed.

### Acceptance criteria

- Hermes messaging parity cannot be satisfied by OpenClaw messaging assertions.
- Pairing parity cannot be satisfied if allowlist is preconfigured and pairing path is bypassed.
- WebSocket credential rewrite must be observed through fake gateway capture.

## Phase 8: Credentials, Security Policy, and Shields Parity

### Audit sections covered

- `test-credential-migration.sh`
- `test-credential-sanitization.sh`
- `test-network-policy.sh`
- `test-shields-config.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-nvidia-credential-migration.yaml`
- baseline `openclaw-nvidia.yaml` for credential sanitization prerequisite sandbox
- `cloud-nvidia-openclaw-network-policy-restricted.yaml`
- `openclaw-nvidia-shields.yaml`

### Required fixtures/runtime actions

- legacy `~/.nemoclaw/credentials.json` staging with allowlisted and malicious keys;
- symlink victim fixture;
- mock migration bundle with fake secrets and symlinked `auth-profiles.json`;
- blueprint digest test fixture;
- restricted-policy sandbox setup;
- interactive/non-interactive policy-add runtime action;
- permissive policy runtime action last;
- shields up/down runtime actions and audit reset fixture.

### Required assertions

- migration notice emitted and legacy plaintext removed;
- tampered keys do not become providers;
- credentials list is gateway-backed and no plaintext file is recreated;
- symlink-safe unlink preserves victim;
- sanitizer strips credential-like fields and preserves non-credential fields;
- sandbox leak scans find no credential patterns;
- policy deny-by-default, preset adds, dry-run no-op, Jira binary scope, inference exemption, hot reload, permissive mode, SSRF validation;
- shields file mode/owner transitions, config redaction, audit JSON validity/no secrets, auto-restore, double-command rejection.

### Acceptance criteria

- Credential migration and sanitization are separate mapped domains.
- Network policy parity is not mapped by a single policy-present check.
- Shields parity is not mapped by status/config consistency alone; up/down/audit/auto-restore behavior must be asserted.

## Phase 9: Sandbox Lifecycle, State, Backup, Snapshot, and Skill Parity

### Audit sections covered

- `test-sandbox-operations.sh`
- `test-sandbox-rebuild.sh`
- `test-sandbox-survival.sh`
- `test-snapshot-commands.sh`
- `test-state-backup-restore.sh`
- `test-skill-agent-e2e.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-nvidia-multisandbox-operations.yaml`
- `openclaw-nvidia-rebuild.yaml`
- `openclaw-nvidia-survival.yaml`
- `openclaw-nvidia-snapshot.yaml`
- `openclaw-nvidia-open-policy-backup-restore.yaml`
- `openclaw-nvidia-skill-agent.yaml`

### Required fixtures/runtime actions

- two-sandbox setup and alternate dashboard URL fixture;
- registry deletion fixture;
- gateway process/container kill runtime actions;
- workspace, agent, nested marker fixtures;
- snapshot create/list/restore runtime actions with timestamp selection;
- workspace backup/destroy/recreate/restore runtime actions;
- skill injection fixture and model flake classifier.

### Required assertions

- list/status/logs/chat basics;
- registry rebuild after deleting `sandboxes.json`;
- gateway recovery and SSH recovery;
- multi-sandbox metadata and network isolation;
- rebuild marker preservation and backup sanitization;
- survival across gateway stop/start with markers and live inference intact;
- snapshot latest and targeted timestamp restore;
- backup captures and restores exact identity/memory files;
- agent reads injected skill and returns verification token, with external flake classification only after fixture presence is proven.

### Acceptance criteria

- Snapshot parity requires timestamp restore and sanitization, not only create/list/latest restore.
- State backup parity requires destroy/recreate/restore, not only backup capture.
- Sandbox operations parity requires multi-sandbox isolation and recovery assertions.

## Phase 10: Rebuild, Upgrade, Installer Version, and Runtime Edge Parity

### Audit sections covered

- `test-rebuild-openclaw.sh`
- `test-rebuild-hermes.sh`
- `test-upgrade-stale-sandbox.sh`
- `test-openshell-gateway-upgrade.sh`
- `test-openshell-version-pin.sh`
- `test-overlayfs-autofix.sh`
- `test-openclaw-plugin-runtime-exdev.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-nvidia-custom-policies-rebuild.yaml`
- `hermes-nvidia-discord-rebuild.yaml`
- `openclaw-nvidia-upgrade-stale.yaml`
- `openshell-gateway-upgrade-survivor.yaml`
- setup-only `installer-openshell-version-pin.yaml` only if needed
- `openclaw-nvidia-overlayfs-autofix.yaml`
- `openclaw-build-plugin-runtime-exdev.yaml`

### Required fixtures/runtime actions

- old OpenClaw and Hermes base image fixtures;
- temporary blueprint min-version mutation with guaranteed restore;
- registry/session staging with old agent versions;
- fake compatible endpoint for upgrade survivor;
- old/current installer refs;
- macOS hermetic installer asset fixtures;
- Docker daemon mutation backup/restore;
- patched cluster image fixture;
- temporary policy mutation for `/dev` and `/dev/shm`;
- EXDEV repro source/destination fixture.

### Required assertions

- rebuild preserves markers, policies, messaging config, and backup sanitization;
- agent version changes from old to expected current;
- upgrade check reports stale before rebuild and up-to-date after rebuild;
- OpenShell gateway upgrade backs up/restores survivor and preserves marker/registry;
- installer replaces too-new OpenShell with pinned compatible version;
- overlayfs autofix creates and reuses patched image and opt-out negative path behaves correctly;
- OpenClaw plugin runtime dependency replacement avoids EXDEV/cross-device rename failure.

### Acceptance criteria

- Rebuild parity requires old-sandbox fixture setup, not fresh sandbox rebuild only.
- Policy preservation must be asserted in registry, live gateway, and backup manifest where legacy did so.
- Installer-only parity remains setup/hermetic and is not forced into a product instance manifest.

## Phase 11: Gateway, Dashboard, Device Auth, Crash Loop, Tunnel, and Remote Service Parity

### Audit sections covered

- `test-dashboard-remote-bind.sh`
- `test-device-auth-health.sh`
- `test-gateway-health-honest.sh`
- `test-gateway-drift-preflight.sh`
- `test-issue-2478-crash-loop-recovery.sh`
- `test-tunnel-lifecycle.sh`
- `test-openclaw-tui-chat-correlation.sh`

### Required manifest expansion

Add or verify manifests for:

- `openclaw-nvidia-dashboard-remote-bind.yaml`
- `openclaw-nvidia-device-auth.yaml`
- setup-only `gateway-health-honest.yaml`
- setup-only `gateway-drift-preflight-negative.yaml` only if useful
- `cloud-nvidia-openclaw-gateway-crash-loop.yaml`
- `openclaw-nvidia-tunnel.yaml`
- `openclaw-nvidia-tui-chat-correlation.yaml`

### Required fixtures/runtime actions

- dashboard bind env and forward table reader;
- device-auth dashboard/root/health probes;
- gateway kill/recovery runtime action;
- fake OpenShell/Docker drift fixtures;
- gateway crash shim fixture;
- guard-chain env file manipulation fixture;
- Cloudflare `cloudflared` install/classifier fixture;
- Vitest live wrapper for TUI/chat correlation.

### Required assertions

- dashboard forward binds all interfaces, not localhost;
- device-auth health treats `/health=200` and root `401` correctly and status is not offline;
- crash shim cannot be reported healthy and leaves no orphan gateway;
- drift preflight fails closed and avoids unsafe sandbox list call;
- guard-chain recovery survives repeated gateway crashes and soak;
- tunnel URL appears in status, serves OpenClaw dashboard, and disappears after stop;
- TUI/chat correlation Vitest passes against live gateway websocket.

### Acceptance criteria

- Gateway health parity cannot be mapped by generic `/health` checks alone.
- Tunnel parity must distinguish NemoClaw faults from Cloudflare transient skips.
- Crash-loop parity requires repeated kill/recovery and guard-chain checks, not a single recovery probe.

## Phase 12: Clean the House

### Cleanup tasks

- Remove or retire dead placeholder assertion groups that are superseded by real modules.
- Remove stale migration-only aliases once every covered behavior has `mapped-live`, `mapped-hermetic`, or `retired` status.
- Update `test/e2e/docs/README.md` with the contract model and parity status vocabulary.
- Update `test/e2e/docs/MIGRATION.md` with final wave status and retirement guidance.
- Update `AGENTS.md` only if new recurring agent instructions are needed for scenario parity work.
- Resolve TODOs introduced by this implementation.
- Ensure generated parity inventory/report files are deterministic.

### Acceptance criteria

- No `metadata-only` entry is presented as complete parity.
- No `partial` entry remains without an owner or follow-up issue.
- All fixture cleanup/restore obligations are documented and tested.
- Legacy script retirement candidates are listed but not deleted unless explicitly approved in a later task.

## Cross-Phase Acceptance Gates

These gates apply to every phase:

1. **Setup gate:** the scenario contract declares environment, manifest or explicit no-manifest reason, fixtures, runtime actions, and assertions.
2. **No-cheat gate:** preview/dry-run output cannot move parity status beyond `metadata-only`.
3. **Boundary gate:** assertions touch the same SUT boundary as the legacy script: host CLI, gateway, sandbox, agent runtime, provider/integration, or durable state.
4. **Evidence gate:** every assertion emits an evidence path and stable assertion ID.
5. **Secret gate:** no manifest, log, report, or fixture file contains raw secrets.
6. **Cleanup gate:** fixtures that mutate host or repo state have restore/cleanup logic and tests.
7. **Inventory completeness gate:** every in-scope `test/e2e/test-*.sh` row from the audit has a parity inventory entry, contract owner, and status; new or renamed legacy scripts discovered during implementation must be added to the inventory or explicitly retired with rationale.
8. **Phase completion gate:** a phase is complete only when every script/behavior assigned to that phase is `mapped-live`, `mapped-hermetic`, or `retired`; `partial`, `metadata-only`, and `deferred` rows must keep the phase incomplete and must include an owner or follow-up issue.
9. **Executable assertion gate:** completed scenarios must point to concrete suite steps/assertion modules, not `pendingStep(...)`, TODO stubs, generic health probes, or validation-plan prose.

## Traceability Matrix

| Phase | Primary audit script groups | Main expansion area |
|---|---|---|
| 1 | all | parity status and scenario contract foundation |
| 2 | host-only/hermetic setup scripts | fixtures, setup-only scenarios, expected failures |
| 3 | onboarding/install scripts | manifests, install/onboard actions, negative onboarding |
| 4 | inference/routing/config scripts | provider fixtures, route/config assertions, runtime overrides |
| 5 | GPU/Ollama scripts | GPU/Ollama env, auth proxy fixtures, token assertions |
| 6 | messaging lifecycle scripts | multi-channel manifests, channel runtime actions |
| 7 | deep messaging agent flows | fake gateways/APIs, credential rewrite, pairing |
| 8 | credentials/security/policy/shields | credential fixtures, policy runtime actions, shields lifecycle |
| 9 | sandbox state/lifecycle | multi-sandbox, recovery, backup, snapshot, skill fixtures |
| 10 | rebuild/upgrade/runtime edge | old images, upgrade fixtures, installer hermetic paths |
| 11 | gateway/dashboard/tunnel | gateway crash/recovery, device auth, dashboard/tunnel actions |
| 12 | all | cleanup, docs, retirement readiness |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Coding agent maps assertions by metadata only | Enforce parity statuses and no-cheat gate in tests. |
| Product manifests become polluted with E2E fixture data | Keep separate fixture/runtime-action contracts; reject raw fake secrets and assertion IDs in manifests. |
| Phases become too large | Each phase can land by domain; defer unmapped rows as `deferred` with owner. |
| Live external providers cause flakes | Separate deterministic config/state assertions from retryable live/external assertions and use explicit transient classifiers. |
| Dangerous fixtures leave host state mutated | Require cleanup/restore obligations and tests for daemon, hosts, blueprint, policy, and image mutations. |
| Legacy scripts are retired before parity is real | This spec does not delete legacy scripts; retirement requires later approval and parity evidence. |

## Definition of Done

This spec is complete when:

- every legacy top-level E2E behavior in the audit has a scenario contract;
- each scenario contract clearly identifies environment setup, product manifest or no-manifest reason, fixtures, runtime actions, and assertion modules;
- all completed parity entries are `mapped-live`, `mapped-hermetic`, or `retired` with rationale;
- no completed parity entry depends on dry-run/preview output alone;
- the scenario framework can produce reports that show setup parity and assertion parity separately;
- legacy script deletion is possible as a separate, explicitly approved follow-up.
