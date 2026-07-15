<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# MCP tool discovery runtime dependency review

The shared image runtime uses the official `@modelcontextprotocol/sdk` client so all NemoClaw agent images follow the same Streamable HTTP initialization, protocol-version, session, SSE, pagination, and cleanup behavior. It is not an agent adapter and never invokes a discovered tool.

## Reviewed pin

- Package: `@modelcontextprotocol/sdk@1.29.0`
- Registry tarball: `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz`
- Integrity: `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==`
- License: MIT
- Locked production graph: `package-lock.json` (lockfile version 3)

The same SDK version and integrity are already present in the separately locked OpenClaw `mcporter` dependency graph. This runtime keeps a direct lock because Hermes and LangChain Deep Agents Code must not depend on OpenClaw's adapter package.

## Build and audit contract

Every agent image installs this committed graph with `npm ci --ignore-scripts --omit=dev` through the same reviewed installer.
The installer applies the existing public corporate CA build argument to npm TLS when present.
The image build requires a clean low-severity advisory audit, verified npm registry signatures, a root-owned non-writable runtime tree, and an executable invalid-input contract check before the image can complete.

Review evidence on 2026-07-14:

- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities
- `npm audit signatures`: 93 packages with verified registry signatures and 7 packages with verified attestations

## Updating

Regenerate and review the graph explicitly:

```console
$ npm --prefix tools/mcp-tool-discovery-runtime install --package-lock-only --ignore-scripts --omit=dev
$ npm --prefix tools/mcp-tool-discovery-runtime ci --ignore-scripts --omit=dev
$ npm --prefix tools/mcp-tool-discovery-runtime audit --omit=dev --audit-level=low
$ npm --prefix tools/mcp-tool-discovery-runtime audit signatures
```

Update this review, the exact package pin, and the committed lock together. Do not replace the lock with a floating install or reuse an agent-specific dependency tree.
