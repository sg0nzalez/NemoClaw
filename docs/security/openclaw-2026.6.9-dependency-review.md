# OpenClaw 2026.6.9 Dependency Review

Review date: 2026-06-22

Scope: NemoClaw runtime pin `openclaw@2026.6.9`.

## Package Identity

- npm package: `openclaw@2026.6.9`
- npm tarball: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.9.tgz`
- npm integrity: `sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==`
- npm publish time: `2026-06-21T01:37:53.047Z`

## Advisory Check

Command run from a temporary directory:

```bash
npm init -y
npm install --package-lock-only --ignore-scripts --no-fund --no-audit openclaw@2026.6.9
npm audit --omit=dev --json
```

Result: npm audit exited `0` and reported `0` info, `0` low, `0` moderate, `0` high, and `0` critical vulnerabilities.

This review is an advisory snapshot for the direct OpenClaw runtime package and its npm dependency graph at review time. It complements, but does not replace, the committed npm integrity pin and Dockerfile install-time registry integrity check.

## Runtime Proof Boundary

The OpenClaw 2026.6.9 package shape no longer exposes the older Slack private inbound test helpers used by NemoClaw's stronger installed-runtime `app_mention` authorization proof. The current E2E fallback proves:

- the rendered Slack allowlist config contains the expected allowed user and excludes the denied user;
- installed OpenClaw `sendMessageSlack` posts through the hermetic fake Slack API; and
- OpenShell rewrites the Slack bot token at the host boundary before egress.

It intentionally does not claim installed-runtime Slack inbound `app_mention` allow/deny coverage for OpenClaw 2026.6.9. Remove that accepted gap when OpenClaw exposes a stable public Slack inbound test/runtime facade, or when NemoClaw has a black-box channel event harness that can drive the installed Slack channel ingress path without private package internals.

## PR Review Follow-ups

### Slack Inbound `app_mention`

The PR review warning for the Slack fallback is accepted as a runtime proof boundary, not as a claimed pass. The installed `openclaw@2026.6.9` dist does not expose `createInboundSlackTestContext` or `prepareSlackMessage`, so NemoClaw cannot currently drive the installed Slack inbound `app_mention` allow/deny path through a stable public package surface.

Current coverage remains deliberately narrower:

- `test/e2e/lib/slack-api-proof.sh` detects the missing private inbound helper shape and returns the `openclaw-runtime-api` proof kind instead of fabricating inbound coverage.
- `test/e2e/test-messaging-providers.sh` requires rendered Slack allowlist config, installed `sendMessageSlack` execution through the fake Slack API, and host-side Slack bot-token rewrite for the fallback path.
- The stronger installed-runtime `app_mention` allow/deny plus bounded denied-feedback proof still runs for package shapes that expose the private helper surface.

Do not close this gap by changing the fallback to a soft pass for inbound authorization. Close it only when OpenClaw publishes a stable Slack inbound runtime/test facade, or when NemoClaw adds a black-box Slack event harness that exercises the installed ingress path without package-private internals.

### Issue #4434 TUI Unreachable Inference

The #4434 live guards in this version-bump PR are partial regression guards. They prove OpenClaw 2026.6.9 no longer leaves the TUI in the broken spinner-plus-connected state when sandbox egress to NVIDIA inference is blocked, and they require a visible `run error`, a concrete unreachable-inference cause token, a recognizable final status line, and final `| error` status inside the default 180-second timeout.

They intentionally do not require the full #4434 acceptance clauses for a gateway/upstream reporting layer or a one-line recovery hint, because OpenClaw 2026.6.9 does not emit those fields for the synthetic DOCKER-USER iptables outage. Tighten both `test/e2e/test-issue-4434-tui-unreachable-inference.sh` and `test/e2e-scenario/live/issue-4434-tui-unreachable-inference.test.ts` once the upstream output includes that layer and recovery hint.
