# OpenClaw 2026.6.9 Dependency Review

Review date: 2026-06-22

Scope: NemoClaw runtime pin `openclaw@2026.6.9`, runtime helper pin `@zed-industries/codex-acp@0.11.1`, optional OpenClaw plugins, and built-in messaging OpenClaw plugins.

## Package Identity

- npm package: `openclaw@2026.6.9`
- npm tarball: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.9.tgz`
- npm integrity: `sha512-y0PGUdE87S8QtQXABPDL0CjNKhH3q/R1h9/WiRQkhVCGSBVhs63/M1iZn2DYVyJCAbDyMz3KNyAE0WzSQIWCRg==`
- npm publish time: `2026-06-21T01:37:53.047Z`
- Codex ACP runtime helper package: `@zed-industries/codex-acp@0.11.1`
- Codex ACP runtime helper npm integrity: `sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==`
- Diagnostics OTEL plugin package: `@openclaw/diagnostics-otel@2026.6.9`
- Diagnostics OTEL plugin npm integrity: `sha512-jU2q4L6L3qdZZDEIDXrWgwCWOGUaTSF+YzUlfgHED42TB4N3maF6seYchFpwKLB8neOzIDpnzMagEMjxZ/7Wqw==`
- Brave search plugin package: `@openclaw/brave-plugin@2026.6.9`
- Brave search plugin npm integrity: `sha512-8HawXB5ylo+vkvkmDJZAE9uhOtm0l9YtzrVqJdM4UqwXeF4uGAkVEOrR3Hxy0sI3Moi5ZBzq2Jx/K5ZQKdiWjQ==`
- Discord channel plugin package: `@openclaw/discord@2026.6.9`
- Discord channel plugin npm integrity: `sha512-esFhwYW0nrFQvBhkPeK/1qmvumlVAY8ddhYBt7geIYLlBriwPJRwtnVLLfp0n1LbS0/XVZ0ORqlvkWq8Vv61vg==`
- Slack channel plugin package: `@openclaw/slack@2026.6.9`
- Slack channel plugin npm integrity: `sha512-JZHc0L3s6s+yBsWowZtE/DWZJOuy4lTE6uTuUbF5QNjUvQQUlCHMFrwPycrXLesVq1il5yAvo82VbERRsIzgxQ==`
- WhatsApp channel plugin package: `@openclaw/whatsapp@2026.6.9`
- WhatsApp channel plugin npm integrity: `sha512-HWz9CryGcSk5ork03DlESVlRcDBnwuXPEKgqdSz/Qt0OnQ2Z1wqNGpwVlAqngvDQDH2AzkNXWuTu2M0C16R8vA==`
- Microsoft Teams channel plugin package: `@openclaw/msteams@2026.6.9`
- Microsoft Teams channel plugin npm integrity: `sha512-Ye1nf2fZYGM3lqQJ/zGlhToThyz1lLZE7HqR2F31iWcD5pV89+eEyRFNNH2FrwYeDVjw+EyWpQh2RkN1r867qg==`
- WeChat channel plugin package: `@tencent-weixin/openclaw-weixin@2.4.3`
- WeChat channel plugin npm integrity: `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`

NemoClaw enforces the main `openclaw@2026.6.9`, `@zed-industries/codex-acp@0.11.1`, and each reviewed npm plugin registry integrity, including optional OTEL/brave plugins and messaging plugins, before running `npm install` or `openclaw plugins install`.

## Advisory Check

Command run from a temporary directory:

```bash
npm init -y
npm install --package-lock-only --ignore-scripts --no-fund --no-audit \
  openclaw@2026.6.9 \
  @zed-industries/codex-acp@0.11.1 \
  @openclaw/diagnostics-otel@2026.6.9 \
  @openclaw/brave-plugin@2026.6.9 \
  @openclaw/discord@2026.6.9 \
  @openclaw/slack@2026.6.9 \
  @openclaw/whatsapp@2026.6.9 \
  @openclaw/msteams@2026.6.9 \
  @tencent-weixin/openclaw-weixin@2.4.3
npm audit --omit=dev --json
```

Result: npm audit exited `0` and reported `0` info, `0` low, `0` moderate, `0` high, and `0` critical vulnerabilities across `763` total dependencies.
The local install emitted npm `EBADENGINE` warnings under Node `22.16.0` for packages that require newer Node `22.x` builds; the audit still completed and is used here only as advisory vulnerability evidence for the locked dependency graph.

This review is an advisory snapshot for the direct OpenClaw runtime package, Codex ACP runtime helper, optional plugins, messaging plugins, and their npm dependency graphs at review time. It complements, but does not replace, the committed npm integrity pins, Dockerfile install-time registry integrity checks, and plugin install-time registry integrity checks.

## Slack Source Review

The main `openclaw@2026.6.9` package excludes `dist/extensions/slack/**`; its channel catalog points Slack installs to the external npm plugin `@openclaw/slack`. The reviewed `@openclaw/slack@2026.6.9` artifact exposes:

- `dist/runtime-api.js`, which exports `sendMessageSlack`;
- `dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`; and
- the denied channel-user gate containing `Blocked unauthorized slack sender ${senderId} (not in channel users)`, which NemoClaw's `slack-channel-guard` preload patches to emit one bounded sender-facing denial notice for explicit `app_mention` events.

The retained Slack proof scripts now import the installed external `@openclaw/slack@2026.6.9` runtime files when the older private `test-api.js` facade is absent. The installed-runtime proof exercises `prepareSlackMessage` from `dist/pipeline.runtime-*.js`, verifies an allowed channel `app_mention`, verifies a denied channel user receives exactly one bounded sender-facing feedback action, and sends through `sendMessageSlack` from `dist/runtime-api.js` against the hermetic fake Slack API.

## Telegram Source Review

The main `openclaw@2026.6.9` package no longer includes `dist/extensions/telegram/test-api.js`. Its bundled Telegram channel still exposes `dist/extensions/telegram/runtime-api.js`, which exports `sendMessageTelegram` and accepts NemoClaw's hermetic fake Telegram API override for send proof.

The retained Telegram proof script now resolves the installed `openclaw/dist/extensions/telegram/runtime-api.js` file, verifies that `sendMessageTelegram` is exported, sends through that runtime API against the host-side fake Telegram Bot API, and keeps the OpenShell REST policy, token rewrite assertion, chat/text capture, and placeholder-leak checks unchanged.

## PR Review Follow-ups

### Installer Integrity Transaction Boundary

The committed npm SRI checks are registry-drift gates, not lockfile-style artifact binding. `Dockerfile`, `Dockerfile.base`, and the messaging build applier verify the reviewed `dist.integrity` for `openclaw@2026.6.9`, `@zed-industries/codex-acp@0.11.1`, optional OpenClaw plugins, and built-in messaging OpenClaw plugins before install, then `npm install -g` or `openclaw plugins install` performs its own registry transaction.

Accepted residual risk: a compromised or inconsistent registry mirror could return the reviewed SRI for the preflight lookup and different install metadata later. This PR accepts that residual installer-trust risk for the OpenClaw 2026.6.9 bump because the change is a dependency-version compatibility update, not an installer architecture migration, and because the current guard still fails closed on missing or changed reviewed SRI before any install starts. Do not treat these checks as proving lockfile-enforced or tarball-enforced artifact pinning.

Invalid state: claiming the committed SRI pins bind the later install transaction. Source boundary: Dockerfile npm install blocks, `Dockerfile.base`, optional plugin install blocks, and `src/lib/messaging/applier/build/messaging-build-applier.mts`. Source-fix constraint: robust artifact binding requires a lockfile, reviewed tarball path, or post-install artifact verifier that enforces the committed SRI against the installed artifact. Regression test: `test/openclaw-integrity-pin.test.ts` verifies fail-closed pre-install drift detection and keeps this accepted residual-risk note present. Removal condition: replace the preflight-only pattern with artifact-bound installation and add a split-registry fake test where `npm view` returns the reviewed SRI but the later install receives a different artifact.

### OpenClaw Compiled-Dist Patch Runtime Boundary

The OpenClaw 2026.6.9 compiled-dist patches are localized compatibility patches for sandbox fetch routing, cron preflight proxying, `host.openshell.internal` web_fetch scoping, unconfigured strict-fetch managed-proxy activation, and `chat.send`/`get-reply` correlation. The long-term source of truth for these behaviors remains upstream OpenClaw; NemoClaw's Dockerfile and patch scripts carry fail-closed version-shape patches only so the reviewed package can run inside the current NemoClaw/OpenShell sandbox contract.

Invalid state: a real installed `openclaw@2026.6.9` dist changes semantics while fixture-compatible recognizers still pass. Source boundary: the installed OpenClaw generated `dist` files, the Dockerfile fetch-guard patch block, and `scripts/patch-openclaw-chat-send.js`. Source-fix constraint: upstream OpenClaw should own permanent fixes; NemoClaw patches must stay version-scoped, fail closed on unknown shapes, and be removed when upstream ships reviewed behavior. Regression tests: `test/fetch-guard-patch-regression.test.ts` and `test/openclaw-chat-send-patch.test.ts` execute patched fixtures for the reviewed shapes, while the PR CI image builds and focused/full nightly E2Es provide built-image runtime smoke on the exact head.

Accepted residual risk: this dependency bump does not add a separate checked-in real-package runtime harness that imports the patched `openclaw@2026.6.9` dist after Dockerfile mutation for every patched path. That gap is accepted for this bump only with exact-head CI image builds, focused nightly proof for the affected E2Es, and final full nightly proof before merge. Removal condition: delete the localized patches when OpenClaw ships the behavior, or add a real-package/built-image runtime harness if NemoClaw keeps carrying these patches beyond this reviewed bump.

### OpenClaw Diagnostics OTEL Host Gateway Boundary

The default `NEMOCLAW_OPENCLAW_OTEL_ENDPOINT=http://host.openshell.internal:4318` is scoped to the local OTLP traces collector and requires the dedicated `openclaw-diagnostics-otel-local` policy preset. That preset allows only `POST /v1/traces` and `POST /v1/traces/**` to `host.openshell.internal:4318` for the OpenClaw/node binaries, separate from the `web_fetch` host-gateway exception in Patch 2b.

The reviewed `@openclaw/diagnostics-otel@2026.6.9` package dist imports `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-proto`, resolves the configured OTLP endpoint, and contains no `web_fetch`, `fetchWithSsrFGuard`, or `withTrustedEnvProxy` references. That source boundary keeps diagnostics export traffic on the OpenTelemetry OTLP exporter path rather than NemoClaw's patched OpenClaw `web_fetch` helper. Removal condition: re-audit this boundary on the next diagnostics plugin bump or if the OTEL plugin starts routing exports through OpenClaw tool/web fetch APIs.

### Legacy Fixture Pins

The legacy `2026.3.11` and `2026.4.24` OpenClaw pins are retained only for stale-upgrade fixture builds. Production Dockerfile install blocks now reject those versions unless `NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1` is set explicitly. The E2E-scoped name is intentionally noisy so production build workflows do not treat it as a general override. Production image workflows run `scripts/check-production-build-args.sh` before production Docker builds so the fixture flag cannot be passed through production build args. The stale-upgrade E2E build contexts pass that flag when they intentionally build an old base image, and `test/openclaw-integrity-pin.test.ts` verifies the default rejection, the explicit fixture opt-in, and the workflow guard.

Invalid state: a production image build overriding `OPENCLAW_VERSION` to an old fixture pin while still passing integrity checks. Source boundary: Dockerfile and Dockerfile.base install blocks. Source-fix constraint: keep stale-upgrade E2Es able to build old images without normalizing those pins as production targets. Regression test: `test/openclaw-integrity-pin.test.ts` rejects legacy pins without the fixture flag. Removal condition: delete the legacy pins and fixture flag after the stale-upgrade/rebuild E2Es no longer need old OpenClaw base images.

### Slack Inbound `app_mention`

The external `@openclaw/slack@2026.6.9` package no longer needs to be treated as package-shape-only evidence. `test/e2e/lib/slack-api-proof.sh` discovers the installed external runtime files, imports the hashed pipeline runtime for `prepareSlackMessage`, imports the runtime API for `sendMessageSlack`, and only reports `openclaw-pipeline-runtime` after allowed prepare, denied prepare, bounded denied-user feedback, and fake Slack send evidence all pass.

Invalid state: claiming `openclaw-pipeline-runtime` inbound proof without both checked-in import logic and fake Slack capture evidence. Source boundary: `test/e2e/lib/slack-api-proof.sh` and `test/e2e/test-messaging-providers.sh`. Source-fix constraint: send-only `runtime-api.js` coverage is not enough for inbound authorization coverage. Regression test: a fake installed `@openclaw/slack` with `dist/pipeline.runtime-fixture.js` and no `test-api.js` must report full coverage only after allowed prepare, denied prepare, bounded denial feedback, and installed send evidence.

### Telegram Runtime Send

The bundled OpenClaw Telegram channel proof must use the current `dist/extensions/telegram/runtime-api.js` surface. `test/e2e/lib/telegram-api-proof.sh` fails closed if the installed runtime file is missing or if it stops exporting `sendMessageTelegram`, because falling back to the removed private `test-api.js` facade would make the 2026.6.9 package-shape proof stale.

Invalid state: a passing fake Telegram proof that imports `dist/extensions/telegram/test-api.js` or bypasses OpenClaw's installed runtime send helper. Source boundary: `test/e2e/lib/telegram-api-proof.sh` and `test/e2e/test-messaging-providers.sh`. Source-fix constraint: keep the host-side fake Telegram API, request-body credential rewrite policy, token rewrite assertion, chat/text capture, and placeholder-leak checks intact. Regression test: the OpenClaw compatibility guard must require `runtime-api.js`, `sendMessageTelegram`, the Slack installed-runtime proof, Teams integrity metadata, optional plugin integrity pins, and chat-send patch recognizers.

### Issue #4434 TUI Unreachable Inference

The #4434 live guards in this version-bump PR are partial regression guards. They prove OpenClaw 2026.6.9 no longer leaves the TUI in the broken spinner-plus-connected state when sandbox egress to NVIDIA inference is blocked, and they require a visible `run error`, a concrete unreachable-inference cause token, a recognizable final status line, and final `| error` status inside the default 180-second timeout.

They intentionally do not require the full #4434 acceptance clauses for a gateway/upstream reporting layer or a one-line recovery hint, because OpenClaw 2026.6.9 does not emit those fields for the synthetic DOCKER-USER iptables outage. Tighten both `test/e2e/test-issue-4434-tui-unreachable-inference.sh` and `test/e2e-scenario/live/issue-4434-tui-unreachable-inference.test.ts` once the upstream output includes that layer and recovery hint.

Invalid state: treating the partial #4434 guard as full acceptance after upstream starts emitting HTTP status/cause, gateway/upstream layer attribution, or a recovery hint. Source boundary: OpenClaw TUI/chat error output captured by the #4434 live repros. Source-fix constraint: NemoClaw can guard against the old broken spinner state, but the missing diagnostic fields must come from OpenClaw output before the live assertions can require them. Regression detection: `test/issue-4434-error-fields.test.ts` classifies the current reviewed output shape and a future complete-output shape so an OpenClaw bump review has a focused fail signal when those fields appear. Removal condition: when the detector shows all fields present for the reviewed OpenClaw output, tighten both live guards and remove the partial-acceptance wording here.
