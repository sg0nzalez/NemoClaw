<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Progressive tool-disclosure performance test

The progressive tool-disclosure performance test compares direct and
progressive tool visibility for OpenClaw, Hermes, and LangChain Deep Agents
Code against one deterministic synthetic catalog and task corpus. It is the
repeatable comparison harness for this feature.

In principle, it can run on any hardware with a compatible host environment
that supports the recorded model, Node.js and a POSIX-compatible shell, an
OpenAI-compatible vLLM endpoint with `/metrics` and `/tokenize`, Docker-backed
OpenShell sandboxes, `cloudflared` with outbound network access, and the three
agent runtimes. Results apply to the recorded hardware and configuration;
evaluating another hardware configuration requires a separate complete run.

Prepare a new evidence directory with the frozen catalog, task sets, schedule,
manifest template, and generated OpenClaw fixtures:

```bash
npm run performance:tool-disclosure -- prepare \
  --output-dir <campaign-output> \
  --sandbox-base ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:<64-hex-digest>
```

Run the emitted schedule as two fresh campaigns on the same recorded hardware
and inference configuration. Each campaign requires a fresh vLLM process and
fresh sandboxes. Populate `manifest.json` from `manifest.template.json`, and
append the public-safe run records to `runs.jsonl`.

Drive each prepared campaign with a private configuration that identifies the
fresh vLLM container and maps the frozen agent/mode/catalog cells to fresh
sandbox names, container names, and instance IDs:

```bash
npm run performance:tool-disclosure -- execute \
  --output-dir <campaign-output> --config <private-campaign-config.json>
```

Execution uses a recoverable `attempt-journal.jsonl`, verifies the live vLLM
image/configuration and Docker-backed sandbox identities, writes only hashed
private identities to the attestation artifact, materializes content-free
`raw-events.jsonl`, and derives `runs.jsonl`; the summarizer rejects records
that cannot be reproduced from the journal and raw evidence.

Summarize the completed evidence set:

```bash
npm run performance:tool-disclosure -- summarize --output-dir <campaign-output>
```

The summarizer writes `summary.json`, `report.md`, `evidence.json`, and
`SHA256SUMS`. It derives public claim text mechanically and leaves claims
blocked unless the required confidence-interval gate passes for every agent in
both campaigns.

The same package includes a test-scoped independent compositional tool routing
experiment. It runs two-pass atomic decomposition, normalized exact
inner-product retrieval, and a bounded tool-hint refinement. Integration tests
exercise its request-transform contract through the recorder while leaving the
caller-owned executor registry unchanged. The transform is not enabled in the
frozen direct/progressive campaign. Run its deterministic CPU acceptance suite
with:

```bash
npx vitest run --project integration \
  test/performance/tool-disclosure-compositional-*.test.ts \
  test/performance/tool-disclosure-recorder.test.ts
```

Those tests prove routing mechanics and strict route-quality gates with frozen
decomposition inputs. They do not establish a model-level decomposition
improvement. The full protocol explains the separate paired initial/refined
evidence required for that result.

The explicit live smoke also runs a separate routed replay after its frozen
direct/progressive cells. That replay must preserve task correctness and the
expected tool call while reducing model-visible schemas without fallback. It
does not alter either frozen cell and remains claim-ineligible. On an ordinary
GitHub runner, its recorder uses an authenticated, host-local private Docker
bridge inside the trusted runner boundary. Its ephemeral ingress credential is
replaced before upstream forwarding; full campaigns retain the protocol's
local recorder topology.

Run the route-only corpus with a real decomposer using:

```bash
npm run performance:tool-disclosure -- route-acceptance \
  --output-dir <empty-output-directory> \
  --config <private-routing-config.json>
```

The protocol documents the private config, semantic and portable embedding
options, public-safe output, remote-content boundary, and strict exit gates.

See the [progressive tool-disclosure performance-test protocol](../../docs/inference/progressive-tool-disclosure-performance-test.mdx)
for the hardware-neutral workflow, recorder topology, artifact rules, claim
gates, and limitations.
