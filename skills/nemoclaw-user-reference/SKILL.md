<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

---
name: "nemoclaw-user-reference"
description: "Describes the NemoClaw integration layer and blueprint architecture and how they orchestrate compatible agent sandboxes. Use when looking up architecture, agent integration, plugin structure, or blueprint design. Trigger keywords - nemoclaw architecture, nemoclaw agent architecture, nemoclaw plugin blueprint structure, nemoclaw vs openshell, which cli, nemoclaw cli, openshell cli, sandbox commands, nemoclaw cli commands, nemoclaw command reference, nemoclaw enterprise readiness, nemoclaw support boundaries, nemoclaw admin capabilities, nemoclaw control plane, nemoclaw network policy, sandbox egress control operator approval, nemoclaw platform support, nemoclaw launch claims, nemoclaw support matrix, nemoclaw what is supported, nemoclaw status, nemoclaw troubleshooting, nemoclaw debug sandbox issues."
license: "Apache-2.0"
---

# NemoClaw User Reference

## References

- **Load [references/architecture.md](references/architecture.md)** when looking up architecture, agent integration, plugin structure, or blueprint design. Describes the NemoClaw integration layer and blueprint architecture and how they orchestrate compatible agent sandboxes.
- **Load [references/cli-selection-guide.md](references/cli-selection-guide.md)** when user asks to decide whether to use `$$nemoclaw` or `openshell`. Explains when to use `$$nemoclaw` versus `openshell` for NemoClaw-managed sandboxes, including lifecycle, inference, policy, monitoring, file transfer, and gateway operations.
- **Load [references/commands.md](references/commands.md)** when looking up a specific `$$nemoclaw`, `nemohermes`, or `/nemoclaw` subcommand, flag, argument, or exit code. Includes the full CLI reference for standalone NemoClaw commands and agent-specific in-sandbox commands.
- **Load [references/enterprise-readiness.md](references/enterprise-readiness.md)** when answering enterprise evaluation, support-boundary, or admin-capability questions, or when preparing field and customer conversations about what NemoClaw supports today. Classifies NemoClaw enterprise readiness and admin/control-plane capabilities by current support state, with workarounds and tracked issues.
- **Load [references/network-policies.md](references/network-policies.md)** when looking up a specific default endpoint, filesystem path, or the runtime approval sequence NemoClaw applies on blocked requests. Covers the baseline network policy, filesystem rules, and operator approval flow.
- **Load [references/platform-support.md](references/platform-support.md)** when verifying whether a platform, inference provider, agent, messaging integration, or deployment path is validated, partially validated, experimental, or out of scope before relying on it in docs, demos, sales material, or support conversations. Single source of truth for what NemoClaw supports today.
- **Load [references/troubleshooting.md](references/troubleshooting.md)** when diagnosing a reported NemoClaw error, a failed onboard, or unexpected sandbox behavior. Lists fixes for common installation, onboarding, and runtime issues.
