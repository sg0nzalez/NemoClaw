# OpenClaw 2026.6.9 Dependency Review

Review date: 2026-06-22

Scope: NemoClaw runtime pin `openclaw@2026.6.9` and runtime helper pin `@zed-industries/codex-acp@0.11.1`.

## Package Identity

- npm package: `openclaw@2026.6.9`
- npm tarball: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.9.tgz`
- npm integrity: `sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==`
- npm publish time: `2026-06-21T01:37:53.047Z`
- Codex ACP runtime helper package: `@zed-industries/codex-acp@0.11.1`
- Codex ACP runtime helper npm integrity: `sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==`
- Discord channel plugin package: `@openclaw/discord@2026.6.9`
- Discord channel plugin npm integrity: `sha512-esFhwYW0nrFQvBhkPeK/1qmvumlVAY8ddhYBt7geIYLlBriwPJRwtnVLLfp0n1LbS0/XVZ0ORqlvkWq8Vv61vg==`
- Slack channel plugin package: `@openclaw/slack@2026.6.9`
- Slack channel plugin npm integrity: `sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==`
- WhatsApp channel plugin package: `@openclaw/whatsapp@2026.6.9`
- WhatsApp channel plugin npm integrity: `sha512-HWz9CryGcSk5ork03DlESVlRcDBnwuXPEKgqdSz/Qt0OnQ2Z1wqNGpwVlAqngvDQDH2AzkNXWuTu2M0C16R8vA==`
- WeChat channel plugin package: `@tencent-weixin/openclaw-weixin@2.4.3`
- WeChat channel plugin npm integrity: `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`

NemoClaw enforces the main `openclaw@2026.6.9` and `@zed-industries/codex-acp@0.11.1` integrity pins in the Dockerfile install blocks before `npm install`. It also enforces each reviewed npm plugin registry integrity in the messaging build applier before running `openclaw plugins install`.

## Advisory Check

Command run from a temporary directory:

```bash
npm init -y
npm install --package-lock-only --ignore-scripts --no-fund --no-audit openclaw@2026.6.9 @zed-industries/codex-acp@0.11.1
npm audit --omit=dev --json
```

Result: npm audit exited `0` and reported `0` info, `0` low, `0` moderate, `0` high, and `0` critical vulnerabilities across `313` total dependencies.

This review is an advisory snapshot for the direct OpenClaw runtime package, Codex ACP runtime helper, and their npm dependency graphs at review time. It complements, but does not replace, the committed npm integrity pins, Dockerfile install-time registry integrity checks, and plugin install-time registry integrity checks.

## Slack Source Review

The main `openclaw@2026.6.9` package excludes `dist/extensions/slack/**`; its channel catalog points Slack installs to the external npm plugin `@openclaw/slack`. The reviewed `@openclaw/slack@2026.6.9` artifact exposes:

- `dist/runtime-api.js`, which exports `sendMessageSlack`;
- `dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`; and
- the denied channel-user gate containing `Blocked unauthorized slack sender ${senderId} (not in channel users)`, which NemoClaw's `slack-channel-guard` preload patches to emit one bounded sender-facing denial notice for explicit `app_mention` events.

The retained Slack proof scripts still require the older `test-api.js` facade or `openclaw-private-helper` proof kind for full inbound authorization coverage. This PR does not claim live `pipeline.runtime-*.js` proof coverage for the external `@openclaw/slack@2026.6.9` package. Until that proof path is added, the 2026.6.9 Slack source review is package-shape evidence plus install-time integrity enforcement, not a replacement for the existing full inbound `app_mention` proof contract.

## PR Review Follow-ups

### Legacy Fixture Pins

The legacy `2026.3.11` and `2026.4.24` OpenClaw pins are retained only for stale-upgrade fixture builds. Production Dockerfile install blocks now reject those versions unless `NEMOCLAW_ALLOW_LEGACY_OPENCLAW_FIXTURE=1` is set explicitly. The stale-upgrade E2E build contexts pass that flag when they intentionally build an old base image, and `test/openclaw-integrity-pin.test.ts` verifies both the default rejection and the explicit fixture opt-in.

Invalid state: a production image build overriding `OPENCLAW_VERSION` to an old fixture pin while still passing integrity checks. Source boundary: Dockerfile and Dockerfile.base install blocks. Source-fix constraint: keep stale-upgrade E2Es able to build old images without normalizing those pins as production targets. Regression test: `test/openclaw-integrity-pin.test.ts` rejects legacy pins without the fixture flag. Removal condition: delete the legacy pins and fixture flag after the stale-upgrade/rebuild E2Es no longer need old OpenClaw base images.

### Slack Inbound `app_mention`

The external `@openclaw/slack@2026.6.9` package shape review is intentionally narrower than full inbound authorization proof. The package exposes `dist/runtime-api.js` and `dist/pipeline.runtime-*.js`, but this PR does not change `test/e2e/lib/slack-api-proof.sh` or `test/e2e/test-messaging-providers.sh` to import that pipeline. Keep the older private-helper proof contract as authoritative until a follow-up adds and validates installed `pipeline.runtime-*.js` coverage.

Invalid state: claiming `openclaw-pipeline-runtime` inbound proof without checked-in proof scripts that import and exercise that runtime. Source boundary: retained Slack proof scripts, not the dependency review note. Source-fix constraint: do not treat send-only `runtime-api.js` coverage as inbound authorization coverage. Regression test to add in a follow-up: a fake installed `@openclaw/slack` with `dist/pipeline.runtime-fixture.js` and no `test-api.js` must report full coverage only after allowed prepare, denied prepare, bounded denial feedback, and installed send evidence.

### Issue #4434 TUI Unreachable Inference

The #4434 live guards in this version-bump PR are partial regression guards. They prove OpenClaw 2026.6.9 no longer leaves the TUI in the broken spinner-plus-connected state when sandbox egress to NVIDIA inference is blocked, and they require a visible `run error`, a concrete unreachable-inference cause token, a recognizable final status line, and final `| error` status inside the default 180-second timeout.

They intentionally do not require the full #4434 acceptance clauses for a gateway/upstream reporting layer or a one-line recovery hint, because OpenClaw 2026.6.9 does not emit those fields for the synthetic DOCKER-USER iptables outage. Tighten both `test/e2e/test-issue-4434-tui-unreachable-inference.sh` and `test/e2e-scenario/live/issue-4434-tui-unreachable-inference.test.ts` once the upstream output includes that layer and recovery hint.
