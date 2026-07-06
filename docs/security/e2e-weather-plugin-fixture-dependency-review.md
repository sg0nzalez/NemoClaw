# E2E Weather Plugin Fixture Dependency Review

Review date: 2026-07-06

Scope: `test/e2e/fixtures/plugins/weather/package-lock.json` and the secret-free OpenClaw custom-plugin lifecycle regression lane.

## Checked-in Fixture Waiver

The following fixture lockfile is intentionally committed and covered by this review:

- `test/e2e/fixtures/plugins/weather/package-lock.json`

The fixture reproduces a real, version-matched OpenClaw plugin build.
Its lockfile must remain committed so the release-matched peer and development dependency graph is deterministic; generating the lockfile during E2E would allow registry state to change the build without a repository diff.
Automated dependency updates are not enabled for this fixture because its OpenClaw version must move with NemoClaw's reviewed runtime pin rather than independently.

This waiver is limited to test fixture code.
It does not waive review for production dependencies, and it must be revalidated whenever the fixture manifest or lockfile changes.

## Accepted Residual Risk

Registry packages can later be found vulnerable or compromised, and downloaded package code still participates in fixture compilation and the test plugin runtime despite integrity verification and lifecycle-script suppression.
The accepted residual risk is limited to this secret-free E2E lane with read-only contents permission and must be reconsidered on every fixture manifest or lockfile change.

## Compensating Controls

- `typebox`, `openclaw`, and `typescript` use exact installed versions in `package.json`; the OpenClaw peer range expresses runtime compatibility but is not the lockfile's install selector.
- The committed npm lockfile records registry integrity for the resolved dependency graph.
- Every fixture install uses `npm ci --ignore-scripts`; the Docker build also uses `--no-audit --no-fund` and prunes development and peer dependencies before staging the plugin.
- The image build fails if a private `node_modules/openclaw` remains, then verifies that OpenClaw creates the expected link to the stock global runtime.
- The GitHub Actions job has read-only `contents` permission, uses full-SHA-pinned actions, disables checkout credential persistence, and receives no repository secrets.
- The lane is isolated to deterministic test data and uploads only its path-scoped E2E artifact directory.

## Advisory Audit

Run from `test/e2e/fixtures/plugins/weather`:

```bash
npm audit --package-lock-only --ignore-scripts --json
```

Revalidated on 2026-07-06: npm audit exited `0` and reported 0 info, low, moderate, high, or critical vulnerabilities across 308 total dependencies.
The reviewed lockfile has SHA-256 `f32b55ad39698fee28a863f88739c99cebd5c7ab3970af4dd44019510a6e6572`, and every non-root package entry records both its resolved registry URL and integrity value.

The audit is a point-in-time advisory check, not a substitute for the exact lockfile, lifecycle-script suppression, or secret-free workflow boundary.
Rerun it whenever `package.json` or `package-lock.json` changes and again before merge if npm advisory state changes.

## Enforcement and Removal

`test/e2e-fixture-dependency-review.test.ts` fails if any committed `test/e2e/fixtures/**/package-lock.json` is absent from this review and binds the weather fixture to the controls above.
Remove this waiver when the fixture is deleted or when repository-wide automated dependency review explicitly covers E2E fixture lockfiles while preserving the release-matched OpenClaw pin.
