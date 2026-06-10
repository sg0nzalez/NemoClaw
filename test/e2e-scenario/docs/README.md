<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E Vitest Fixtures

NemoClaw E2E now has one target execution model: **Vitest as the harness** and
GitHub Actions as the matrix. Vitest owns discovery, filtering, timeouts,
reporters, fixture lifecycle, skips, and CI integration. NemoClaw owns the
domain layer: scenario metadata, phase fixtures, product clients, evidence
artifacts, redaction, cleanup, expected-state probes, and typed assertion
helpers.

The retired typed-shell scenario runner is documented in
[`RETIREMENT.md`](./RETIREMENT.md). Do not add new durable behavior to the old
YAML/bash scenario-runner shape.

Direct legacy E2E scripts under `test/e2e/test-*.sh` still provide most live
nightly and platform coverage. Those scripts are not deleted by the scenario
runner cutover; migrate them by contract using the rules in `MIGRATION.md`.

## Sources Of Truth

| Task | Source |
| --- | --- |
| Live scenario IDs and metadata | `test/e2e-scenario/scenarios/registry.ts`, `test/e2e-scenario/scenarios/scenarios/baseline.ts` |
| GitHub Actions matrix emission | `test/e2e-scenario/scenarios/run.ts --emit-live-matrix` |
| Live scenario execution | `test/e2e-scenario/live/registry-scenarios.test.ts` |
| Phase fixtures and clients | `test/e2e-scenario/framework/` |
| Expected-state probes | `test/e2e-scenario/scenarios/expected-states.ts` |
| Product-facing setup/onboarding state | `test/e2e-scenario/manifests/*.yaml` |
| Legacy direct E2E coverage | `test/e2e/test-*.sh` and their workflows |
| Migration status and deletion evidence | GitHub issues and pull requests |

## Scenario Model

The typed registry still describes scenarios as layered metadata:

```text
base environment
  -> onboarding profile / manifest
    -> expected state
      -> optional lifecycle profile
        -> suite metadata for migration tracking
```

Live execution happens through Vitest fixtures:

- `environment` checks CLI/install/runtime readiness.
- `onboard` performs supported onboarding profiles.
- `lifecycle` performs supported post-onboard mutations.
- `stateValidation` probes host-observable expected state.
- `artifacts`, `secrets`, `cleanup`, and `shellProbe` provide shared fixture
  services.

`suiteIds` remain metadata for reporting and migration planning. They do not
dispatch shell validation suites.

## How To Run

```bash
# List canonical scenario ids
npx tsx test/e2e-scenario/scenarios/run.ts --list

# Emit the GitHub Actions fan-out matrix payload
npx tsx test/e2e-scenario/scenarios/run.ts --emit-live-matrix

# Emit the matrix for selected scenario ids
npx tsx test/e2e-scenario/scenarios/run.ts --emit-live-matrix --scenarios ubuntu-repo-cloud-openclaw

# Framework tests
npx vitest run --project e2e-scenario-framework --silent=false --reporter=default

# Opt-in live Vitest scenarios
npm run build:cli
NEMOCLAW_RUN_E2E_SCENARIOS=1 npx vitest run --project e2e-scenarios-live --silent=false --reporter=default
```

The retired `--emit-matrix`, direct `--scenarios` execution, and `--plan-only`
paths must not be reintroduced.

## Repository Layout

```text
test/e2e-scenario/
  docs/                  # Framework guide, migration notes, retirement record
  framework/             # Vitest fixtures, clients, redaction, artifacts, cleanup
  framework-tests/       # Fast framework and metadata tests
  live/                  # Opt-in live Vitest scenario tests
  manifests/             # Product-facing NemoClawInstance desired state
  scenarios/             # Typed registry, matrix helpers, expected states
```

## CI Entry Points

- `.github/workflows/e2e-vitest-scenarios.yaml` runs selected or all supported
  live Vitest scenarios and uploads an explicit artifact allowlist with
  JSON summaries plus action, log, and shell command-evidence directories under
  14-day retention.
- Existing workflows such as `nightly-e2e.yaml`, `e2e-branch-validation.yaml`,
  `macos-e2e.yaml`, `wsl-e2e.yaml`, `ollama-proxy-e2e.yaml`, and
  `regression-e2e.yaml` still run direct legacy E2E scripts during migration.
- `vitest.config.ts` contains `e2e-scenario-framework` for fast framework tests
  and `e2e-scenarios-live` for opt-in live scenario execution.

## Migration Tracking

Migration status is tracked outside the repository. GitHub issues and pull
requests are the source of truth for script-by-script state, ownership, deletion
evidence, replacement Vitest coverage, and retirement rationale.

GitHub issues and PRs own changing migration status. The key issues are:

- #3588: parent layered E2E architecture epic
- #4941: Vitest fixtures as the scenario execution model
- #4990: phase fixtures and registry-driven live discovery
- #5098: direct legacy bash-suite migration epic

The former repo-local `legacy-inventory.json` ledger is removed because it
duplicated live GitHub state and drifted quickly. A PR that deletes a legacy E2E
script must show the replacement Vitest coverage or explain the retirement
rationale in the PR body and linked issue.

Prefer new E2E coverage in Vitest fixtures. When shell, installer, process,
platform, or full user-flow behavior is the contract, invoke that real boundary
from Vitest rather than preserving a second durable runner.
