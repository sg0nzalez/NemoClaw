<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw MCP Runtime Dependency Review

This file records the reviewed `mcporter` baseline installed in the OpenClaw sandbox image.
Update it and `agents/openclaw/mcporter-runtime/package*.json` together whenever `MCPORTER_VERSION` or its integrity value changes in `Dockerfile.base` or `Dockerfile`.

- Package: `mcporter@0.7.3`
- Purpose: in-sandbox OpenClaw MCP configuration and client adapter; it is not a host bridge, proxy, relay, or listener.
- Registry source: `https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz`
- Repository: `https://github.com/steipete/mcporter`
- License: `MIT`, from the npm registry package metadata.
- npm integrity: `sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==`
- Registry metadata independently queried from npm: 2026-06-30.
- Locked graph: `agents/openclaw/mcporter-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration command: `npm --prefix agents/openclaw/mcporter-runtime install --package-lock-only --ignore-scripts --omit=dev`
- Advisory command: `npm --prefix agents/openclaw/mcporter-runtime ci --ignore-scripts --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit signatures`
- Advisory review date: 2026-06-30.
- Advisory result: `0` known vulnerabilities across the resolved production dependency graph; npm verified registry signatures for all `120` resolved packages and attestations for `12` packages.

Both image paths install the committed graph with `npm ci --ignore-scripts --omit=dev` because the published package declares no install-time lifecycle script and NemoClaw needs only its already-built CLI.

## WeChat plugin runtime graph

- Package: `@tencent-weixin/openclaw-weixin@2.4.3`.
- Locked graph: `agents/openclaw/wechat-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration: `npm install --package-lock-only --legacy-peer-deps --ignore-scripts --omit=dev --prefix agents/openclaw/wechat-runtime`.
- Installation boundary: the image materializes the reviewed lock into a root-owned dedicated npm cache and adds the exact package metadata needed by npm's offline resolver. The sandbox user copies that immutable source into a writable cache used only for the OpenClaw plugin install, deletes the copy in the same image layer, and never writes to the trusted cache. The installer runs in offline, legacy-peer mode, then `verify-wechat-runtime-lock.mts` rejects integrity, version, or dependency-set drift in the managed npm project.
- Default CI gate: `wechat-runtime-audit` in `.github/workflows/pr.yaml` and `.github/workflows/main.yaml` uses Node `22.19.0` and npm `10.9.4`, materializes the committed graph with scripts disabled, fails on any production advisory, verifies registry signatures, uploads the JSON/text reports, and exercises the exact reviewed archive through a copied writable cache while the trusted source remains read-only.
- Advisory command: `npm ci --ignore-scripts --omit=dev --legacy-peer-deps --prefix agents/openclaw/wechat-runtime && npm audit --omit=dev --audit-level=low --json --prefix agents/openclaw/wechat-runtime && npm audit signatures --prefix agents/openclaw/wechat-runtime`.
- Advisory review: `2026-07-12`; result: `0` known vulnerabilities across the resolved production graph.
- Regression tests: `test/wechat-locked-install.test.ts` keeps the manifest runtime-lock paths and installer verification dispatch synchronized; `test/wechat-runtime-audit-workflow.test.ts` keeps the Docker cache lifecycle, required CI gate, evidence upload, audit threshold, signature verification, and real npm-pack boundary synchronized.

The dedicated graph intentionally omits the plugin's `openclaw` peer dependency. The image already installs and integrity-verifies the reviewed OpenClaw runtime separately; auto-installing another OpenClaw copy would create a second unreviewed runtime graph.
Disabling scripts also prevents transitive packages from executing lifecycle code during the trusted image build.
The lock records the exact version, registry URL, and integrity for every transitive package; the top-level registry integrity check remains an independent control.

## Source-of-Truth Boundary

- `invalidState`: the image installs a package graph, tarball, license, or advisory state that differs from the independently queried npm registry records for `mcporter@0.7.3`.
- `sourceBoundary`: npm owns registry metadata, tarball integrity, provenance signatures, and advisory responses; NemoClaw owns the exact lock, script-disabled install, Docker integrity assertion, and review record.
- `whyNotSourceFix`: a repository note cannot make external registry state trustworthy, so image builds execute `npm audit` and `npm audit signatures` against the locked production graph and reviewers compare the lock with the registry response.
- `regressionTest`: `test/mcporter-supply-chain.test.ts` keeps the version, integrity, lock metadata, Docker install flags, audit commands, and this review synchronized.
- `removalCondition`: remove this runtime dependency and review when OpenClaw provides the required authenticated Streamable HTTP client lifecycle without mcporter, or repeat the independent review for a newly pinned version.
