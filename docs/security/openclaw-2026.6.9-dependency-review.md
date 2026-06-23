# OpenClaw 2026.6.9 Dependency Review

Review date: 2026-06-22

Scope: NemoClaw runtime pin `openclaw@2026.6.9`.

## Package Identity

- npm package: `openclaw@2026.6.9`
- npm tarball: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.9.tgz`
- npm integrity: `sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==`
- npm publish time: `2026-06-21T01:37:53.047Z`
- Discord channel plugin package: `@openclaw/discord@2026.6.9`
- Discord channel plugin npm integrity: `sha512-esFhwYW0nrFQvBhkPeK/1qmvumlVAY8ddhYBt7geIYLlBriwPJRwtnVLLfp0n1LbS0/XVZ0ORqlvkWq8Vv61vg==`
- Slack channel plugin package: `@openclaw/slack@2026.6.9`
- Slack channel plugin npm integrity: `sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==`
- WhatsApp channel plugin package: `@openclaw/whatsapp@2026.6.9`
- WhatsApp channel plugin npm integrity: `sha512-HWz9CryGcSk5ork03DlESVlRcDBnwuXPEKgqdSz/Qt0OnQ2Z1wqNGpwVlAqngvDQDH2AzkNXWuTu2M0C16R8vA==`
- WeChat channel plugin package: `@tencent-weixin/openclaw-weixin@2.4.3`
- WeChat channel plugin npm integrity: `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`

NemoClaw enforces the main `openclaw@2026.6.9` integrity in the Dockerfile install blocks before `npm install`. It also enforces each reviewed npm plugin registry integrity in the messaging build applier before running `openclaw plugins install`.

## Advisory Check

Command run from a temporary directory:

```bash
npm init -y
npm install --package-lock-only --ignore-scripts --no-fund --no-audit openclaw@2026.6.9
npm audit --omit=dev --json
```

Result: npm audit exited `0` and reported `0` info, `0` low, `0` moderate, `0` high, and `0` critical vulnerabilities.

This review is an advisory snapshot for the direct OpenClaw runtime package and its npm dependency graph at review time. It complements, but does not replace, the committed npm integrity pins, Dockerfile install-time registry integrity check, and Slack plugin install-time registry integrity check.

## Slack Source Review

The main `openclaw@2026.6.9` package excludes `dist/extensions/slack/**`; its channel catalog points Slack installs to the external npm plugin `@openclaw/slack`. The reviewed `@openclaw/slack@2026.6.9` artifact exposes:

- `dist/runtime-api.js`, which exports `sendMessageSlack`;
- `dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`; and
- the denied channel-user gate containing `Blocked unauthorized slack sender ${senderId} (not in channel users)`, which NemoClaw's `slack-channel-guard` preload patches to emit one bounded sender-facing denial notice for explicit `app_mention` events.

`test/e2e/lib/slack-api-proof.sh` now prefers the installed `@openclaw/slack` pipeline runtime over the older `test-api.js` facade. It sources `/tmp/nemoclaw-proxy-env.sh` before importing the plugin so the same `NODE_OPTIONS` preload chain used by OpenClaw is active. The proof drives one allowed and one denied `app_mention` through installed `prepareSlackMessage`, then sends the allowed reply through installed `sendMessageSlack` and the hermetic fake Slack API. If a future package shape only exposes `runtime-api.js`, the helper falls back to send-only coverage and reports `openclaw-runtime-api` instead of claiming inbound authorization coverage.

## PR Review Follow-ups

### Slack Inbound `app_mention`

The PR review warning for the Slack fallback is resolved for the 2026.6.9 external Slack plugin shape. The installed `@openclaw/slack@2026.6.9` dist does not expose `createInboundSlackTestContext`, but it does expose `prepareSlackMessage` from `dist/pipeline.runtime-*.js`. NemoClaw now imports that installed pipeline directly for the E2E proof and keeps the older private-helper path for package shapes that still expose `test-api.js`.

Current coverage remains deliberately narrower:

- `test/e2e/lib/slack-api-proof.sh` detects the installed `pipeline.runtime-*.js` shape and returns the `openclaw-pipeline-runtime` proof kind after proving allowed prepare, denied prepare, bounded denial feedback, installed `sendMessageSlack`, and host-side Slack bot-token rewrite.
- `test/e2e/test-messaging-providers.sh` treats `openclaw-pipeline-runtime` and the older `openclaw-private-helper` proof kind as full `M-S17` coverage.
- The send-only `openclaw-runtime-api` branch remains as an explicit fallback for future package shapes that expose outbound send but no importable inbound pipeline.

Do not close this gap by changing the send-only fallback to a soft pass for inbound authorization. The fallback must continue to report `openclaw-runtime-api` unless it actually imports and exercises an installed inbound pipeline or a stable public inbound facade.

### Issue #4434 TUI Unreachable Inference

The #4434 live guards in this version-bump PR are partial regression guards. They prove OpenClaw 2026.6.9 no longer leaves the TUI in the broken spinner-plus-connected state when sandbox egress to NVIDIA inference is blocked, and they require a visible `run error`, a concrete unreachable-inference cause token, a recognizable final status line, and final `| error` status inside the default 180-second timeout.

They intentionally do not require the full #4434 acceptance clauses for a gateway/upstream reporting layer or a one-line recovery hint, because OpenClaw 2026.6.9 does not emit those fields for the synthetic DOCKER-USER iptables outage. Tighten both `test/e2e/test-issue-4434-tui-unreachable-inference.sh` and `test/e2e-scenario/live/issue-4434-tui-unreachable-inference.test.ts` once the upstream output includes that layer and recovery hint.
