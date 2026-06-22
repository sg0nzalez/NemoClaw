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
