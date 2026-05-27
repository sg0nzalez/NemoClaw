// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ParityInventoryEntry, ScenarioContractAssertion } from "./parity.ts";

const AUDIT = "current-main-e2e-coverage-audit.md";

export function getPhaseParityEntries(phase: number): ParityInventoryEntry[] {
  if (phase === 3) return phase3Entries();
  if (phase === 4) return phase4Entries();
  if (phase === 5) return phase5Entries();
  if (phase === 6) return phase6Entries();
  return [];
}

function phase6Entries(): ParityInventoryEntry[] {
  return [
    entry("test/e2e/test-channels-add-remove.sh", "messaging.lifecycle.add-remove", {
      manifest: { scenarioId: "openclaw-nvidia-telegram-channel-lifecycle", channels: [] },
      fixtures: ["channel-fake-token-id", "provider-cache-reader"],
      actions: ["channels.add", "channels.remove", "rebuild"],
      assertions: [
        assertion("messaging.lifecycle.baseline-no-channel", "validation_suites/messaging/lifecycle/00-baseline-no-channel.sh", "host"),
        assertion("messaging.lifecycle.add-remove-rebuild-effects", "validation_suites/messaging/lifecycle/01-add-remove-rebuild-effects.sh", "host"),
      ],
    }),
    entry("test/e2e/test-channels-stop-start.sh", "messaging.lifecycle.stop-start", {
      manifest: { scenarioId: "openclaw-nvidia-telegram-channel-lifecycle", channels: ["telegram"] },
      fixtures: ["provider-cache-reader"],
      actions: ["channels.stop", "channels.start"],
      assertions: [assertion("messaging.lifecycle.stop-start-registry-cache", "validation_suites/messaging/lifecycle/02-stop-start-registry-cache.sh", "host")],
    }),
    entry("test/e2e/test-messaging-providers.sh", "messaging.matrix.all-channels", {
      manifest: { scenarioId: "cloud-nvidia-openclaw-messaging-full-matrix", channels: ["telegram", "discord", "slack", "wechat", "whatsapp"] },
      fixtures: ["messaging-policy-premerge", "whatsapp-add-rebuild"],
      actions: ["channels.add.matrix", "rebuild"],
      assertions: [assertion("messaging.matrix.openclaw-and-hermes-config", "validation_suites/messaging/matrix/00-openclaw-hermes-config.sh", "host")],
    }),
    entry("test/e2e/test-token-rotation.sh", "messaging.token-rotation", {
      manifest: { scenarioId: "openclaw-nvidia-messaging-token-rotation", channels: ["telegram", "discord", "slack"] },
      fixtures: ["token-a-b", "provider-cache-reader"],
      actions: ["channels.rotate-token", "rebuild"],
      assertions: [
        assertion("messaging.rotation.changed-provider-only-rebuild", "validation_suites/messaging/token-rotation/00-provider-rotation-isolated.sh", "host"),
        assertion("messaging.rotation.same-token-no-rebuild", "validation_suites/messaging/token-rotation/01-same-token-no-rebuild.sh", "host"),
      ],
    }),
    entry("test/e2e/test-telegram-injection.sh", "messaging.telegram.injection", {
      manifest: { scenarioId: "openclaw-nvidia-telegram-security", channels: ["telegram"] },
      fixtures: ["injection-payloads", "proof-file-cleanup"],
      actions: ["channels.add.telegram"],
      assertions: [assertion("messaging.telegram.injection-no-exec-no-secret-leak", "validation_suites/messaging/telegram/00-telegram-injection-safety.sh", "host")],
    }),
  ];
}

function phase5Entries(): ParityInventoryEntry[] {
  return [
    entry("test/e2e/test-gpu-e2e.sh", "ollama.gpu.full", {
      manifest: { scenarioId: "local-ollama-openclaw-gpu-full", installSource: "repo-current" },
      fixtures: ["ollama-install-start-model-pull", "docker-container-reachability-probe"],
      actions: ["onboard.local-ollama-openclaw"],
      assertions: [
        assertion("ollama.gpu.sandbox-status-gpu-enabled", "validation_suites/inference/ollama-gpu/00-gpu-status.sh", "sandbox"),
        assertion("ollama.gpu.install-log-proof-markers", "validation_suites/inference/ollama-gpu/01-install-log-proof.sh", "host"),
        assertion("ollama.gpu.host-api-reachable", "validation_suites/inference/ollama-gpu/00-ollama-models-health.sh", "host"),
        assertion("ollama.gpu.inference-local-chat", "validation_suites/inference/ollama-gpu/01-ollama-chat-completion.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-gpu-double-onboard.sh", "ollama.gpu.reonboard", {
      manifest: { scenarioId: "local-ollama-openclaw-reonboard", installSource: "repo-current" },
      fixtures: ["ollama-auth-proxy", "persisted-token", "divergent-token"],
      actions: ["onboard.local-ollama-openclaw", "onboard.local-ollama-openclaw.second-pass"],
      assertions: [
        assertion("ollama.reonboard.token-matches-live-proxy", "validation_suites/inference/ollama-auth-proxy/02-reonboard-token-match.sh", "host"),
        assertion("ollama.reonboard.inference-local-repeat-chat", "validation_suites/inference/ollama-gpu/01-ollama-chat-completion.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-ollama-auth-proxy-e2e.sh", "ollama.proxy.host-only-auth", {
      noManifestReason: "host-only auth proxy scenario",
      fixtures: ["ollama-auth-proxy", "persisted-token"],
      actions: ["ollama.proxy.start", "ollama.proxy.restart"],
      assertions: [
        assertion("ollama.proxy.rejects-unauthenticated-and-wrong-token", "validation_suites/inference/ollama-auth-proxy/01-auth-enforcement.sh", "host"),
        assertion("ollama.proxy.accepts-persisted-token", "validation_suites/inference/ollama-auth-proxy/00-proxy-reachable.sh", "host"),
        assertion("ollama.proxy.token-file-0600", "validation_suites/inference/ollama-auth-proxy/03-token-file-mode.sh", "host"),
        assertion("ollama.proxy.restart-stable-token", "validation_suites/inference/ollama-auth-proxy/04-restart-stable-token.sh", "host"),
      ],
    }),
  ].map((entry) => {
    entry.contract = {
      ...entry.contract,
      environment: { os: "ubuntu", runner: "self-hosted-gpu", requirements: ["docker-cdi", "nvidia-smi"] },
    };
    return entry;
  });
}

function phase4Entries(): ParityInventoryEntry[] {
  return [
    entry("test/e2e/test-bedrock-runtime-compatible-anthropic.sh", "inference.bedrock.compatible-anthropic", {
      manifest: { scenarioId: "openclaw-bedrock-compatible-anthropic", installSource: "repo-current" },
      fixtures: ["fake-bedrock-runtime-endpoint", "bedrock-host-mapping", "bedrock-adapter-state", "provider-key-leak-scan"],
      actions: ["onboard.bedrock-compatible"],
      assertions: [
        assertion("inference.bedrock.adapter-health", "validation_suites/inference/bedrock/00-adapter-health.sh", "fake-service"),
        assertion("inference.bedrock.config-shape", "validation_suites/inference/bedrock/01-config-shape.sh", "host"),
        assertion("inference.bedrock.runtime-chat", "validation_suites/inference/bedrock/02-runtime-chat.sh", "sandbox"),
        assertion("inference.bedrock.traffic-observed", "validation_suites/inference/bedrock/03-traffic-observed.sh", "fake-service"),
        assertion("inference.bedrock.leak-scan", "validation_suites/inference/bedrock/04-leak-scan.sh", "host"),
      ],
    }),
    entry("test/e2e/test-inference-routing.sh", "inference.routing.provider-identity", {
      manifest: { scenarioId: "openai-openclaw-routing", installSource: "repo-current" },
      fixtures: ["fake-compatible-openai-endpoint", "provider-registry-reader"],
      actions: ["onboard.openclaw-compatible"],
      assertions: [
        assertion("inference.routing.provider-route-identity", "validation_suites/inference/routing/01-provider-route-health.sh", "sandbox"),
        assertion("inference.routing.sandbox-chat", "validation_suites/inference/routing/00-inference-local-chat-completion.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-kimi-inference-compat.sh", "inference.kimi.tool-trajectory", {
      manifest: { scenarioId: "compatible-openclaw-kimi", installSource: "repo-current" },
      fixtures: ["fake-kimi-endpoint", "trajectory-session-artifact-reader"],
      actions: ["onboard.kimi-compatible", "agent.prompt.tool-trajectory"],
      assertions: [
        assertion("inference.kimi.trajectory.hostname", "validation_suites/inference/kimi-compatibility/00-plugin-wiring.sh", "sandbox"),
        assertion("inference.kimi.trajectory.date", "validation_suites/inference/kimi-compatibility/01-kimi-compatible-models-route.sh", "sandbox"),
        assertion("inference.kimi.trajectory.uptime", "validation_suites/inference/kimi-compatibility/02-tool-trajectory.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-model-router-provider-routed-inference.sh", "inference.model-router.routed-completion", {
      manifest: { scenarioId: "routed-nvidia-openclaw-model-router", installSource: "repo-current" },
      fixtures: ["model-router-health-endpoint"],
      actions: ["onboard.model-router"],
      assertions: [
        assertion("inference.model-router.healthy-count", "validation_suites/inference/model-router/00-healthy-endpoint.sh", "fake-service"),
        assertion("inference.model-router.routed-completion", "validation_suites/inference/model-router/01-provider-routed-completion.sh", "sandbox"),
      ],
    }),
    switchEntry("test/e2e/test-openclaw-inference-switch.sh", "openclaw-nvidia-inference-switch"),
    switchEntry("test/e2e/test-hermes-inference-switch.sh", "cloud-nvidia-hermes-inference-switch"),
    entry("test/e2e/test-messaging-compatible-endpoint.sh", "inference.messaging-compatible-endpoint", {
      manifest: { scenarioId: "telegram-compatible-openclaw", installSource: "repo-current" },
      fixtures: ["fake-compatible-openai-endpoint", "fake-telegram"],
      actions: ["onboard.compatible", "channels.add.telegram"],
      assertions: [
        assertion("inference.messaging.config-shape", "validation_suites/messaging/common/01-placeholder-configured.sh", "host"),
        assertion("inference.messaging.runtime-route", "validation_suites/inference/routing/00-inference-local-chat-completion.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-runtime-overrides.sh", "inference.runtime-overrides", {
      manifest: { scenarioId: "openclaw-runtime-overrides", installSource: "repo-current" },
      fixtures: ["runtime-override-container", "config-hash-reader"],
      actions: ["runtime.override.valid", "runtime.override.invalid"],
      assertions: [
        assertion("inference.runtime-overrides.config-hash", "validation_suites/inference/runtime-overrides/00-config-hash.sh", "host"),
        assertion("inference.runtime-overrides.reject-invalid", "validation_suites/inference/runtime-overrides/01-reject-invalid.sh", "host"),
      ],
    }),
  ];
}

function switchEntry(legacyScript: string, scenarioId: string): ParityInventoryEntry {
  return entry(legacyScript, "inference.switch.state-registry-config-live", {
    manifest: { scenarioId, installSource: "repo-current" },
    fixtures: ["provider-registry-reader", "session-state-reader", "config-hash-reader"],
    actions: ["inference.set"],
    assertions: [
      assertion("inference.switch.route-state", "validation_suites/inference/switch/00-route-state-updated.sh", "host"),
      assertion("inference.switch.registry-session-state", "validation_suites/inference/switch/01-registry-session-state.sh", "host"),
      assertion("inference.switch.config-hash-shape", "validation_suites/inference/switch/02-config-hash-shape.sh", "host"),
      assertion("inference.switch.post-switch-live-request", "validation_suites/inference/switch/01-switched-inference-local-chat.sh", "sandbox"),
    ],
  });
}

function phase3Entries(): ParityInventoryEntry[] {
  return [
    entry("test/e2e/test-full-e2e.sh", "onboarding.full.cloud-openclaw", {
      manifest: { scenarioId: "ubuntu-repo-cloud-openclaw", installSource: "repo-current" },
      fixtures: ["direct-cloud-prompt", "sandbox-route-prompt", "agent-mediated-prompt"],
      actions: ["install.repo-current", "onboard.openclaw"],
      assertions: [
        assertion("onboarding.cloud.direct-provider-chat", "validation_suites/inference/cloud/01-chat-completion.sh", "live"),
        assertion("onboarding.cloud.sandbox-inference-local-chat", "validation_suites/inference/cloud/02-inference-local-from-sandbox.sh", "sandbox"),
        assertion("onboarding.cloud.agent-mediated-response", "validation_suites/baseline-onboarding/02-route-and-smoke.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-cloud-onboard-e2e.sh", "onboarding.cloud.openclaw.cli-state", {
      manifest: { scenarioId: "ubuntu-repo-cloud-openclaw", installSource: "repo-current" },
      fixtures: ["nvidia-credential-ref", "gateway-state-reader"],
      actions: ["install.repo-current", "onboard.openclaw"],
      assertions: [
        assertion("onboarding.cloud.cli-openshell-available", "validation_suites/baseline-onboarding/00-cli-and-openshell.sh", "host"),
        assertion("onboarding.cloud.registry-session-provider-model-policies", "validation_suites/onboarding/state/00-registry-provider-model-policies.sh", "host"),
      ],
    }),
    entry("test/e2e/test-cloud-inference-e2e.sh", "onboarding.cloud.inference-surfaces", {
      manifest: { scenarioId: "ubuntu-repo-cloud-openclaw", installSource: "repo-current" },
      fixtures: ["direct-cloud-prompt", "sandbox-route-prompt"],
      actions: ["onboard.openclaw"],
      assertions: [
        assertion("onboarding.cloud.direct-provider-chat", "validation_suites/inference/cloud/01-chat-completion.sh", "live"),
        assertion("onboarding.cloud.sandbox-inference-local-chat", "validation_suites/inference/cloud/02-inference-local-from-sandbox.sh", "sandbox"),
      ],
    }),
    entry("test/e2e/test-double-onboard.sh", "onboarding.double.gateway-reuse", {
      manifest: { scenarioId: "ubuntu-repo-openai-compatible-double-onboard", installSource: "repo-current" },
      fixtures: ["fake-openai-endpoint", "gateway-port-probe"],
      actions: ["onboard.openclaw", "onboard.openclaw.second-pass"],
      assertions: [
        assertion("onboarding.double.gateway-reuse", "validation_suites/baseline-onboarding/01-sandbox-state.sh", "host"),
        assertion("onboarding.double.no-port-conflict", "validation_suites/sandbox/lifecycle/00-gateway-health.sh", "host"),
      ],
    }),
    entry("test/e2e/test-onboard-negative-paths.sh", "onboarding.negative.invalid-key-port-conflict", {
      manifest: { scenarioId: "ubuntu-invalid-nvidia-key-negative", installSource: "repo-current" },
      fixtures: ["bad-key", "gateway-port-holder"],
      actions: ["onboard.expect-failure"],
      assertions: [
        assertion("onboarding.negative.failure-message", "validation_suites/onboarding/negative/00-failure-message.sh", "host"),
        assertion("onboarding.negative.no-stack-trace", "validation_suites/onboarding/negative/01-no-stack-trace.sh", "host"),
        assertion("onboarding.negative.no-side-effects", "validation_suites/onboarding/negative/02-no-side-effects.sh", "host"),
      ],
    }),
    entry("test/e2e/test-onboard-resume.sh", "onboarding.resume.after-interrupt", {
      manifest: { scenarioId: "ubuntu-openclaw-resume-after-interrupt", installSource: "repo-current" },
      fixtures: ["interrupted-onboard-session"],
      actions: ["onboard.resume"],
      assertions: [
        assertion("onboarding.resume.cached-steps-skipped", "validation_suites/onboarding/resume/00-cached-steps-skipped.sh", "host"),
        assertion("onboarding.resume.session-completed", "validation_suites/onboarding/resume/01-session-completed.sh", "host"),
      ],
    }),
    entry("test/e2e/test-onboard-repair.sh", "onboarding.repair.existing-config", {
      manifest: { scenarioId: "ubuntu-openclaw-repair-existing-config", installSource: "repo-current" },
      fixtures: ["missing-recorded-sandbox", "conflicting-resume-request"],
      actions: ["onboard.repair"],
      assertions: [
        assertion("onboarding.repair.recreates-missing-sandbox", "validation_suites/onboarding/repair/00-recreates-missing-sandbox.sh", "host"),
        assertion("onboarding.repair.rejects-conflicting-resume", "validation_suites/onboarding/repair/01-rejects-conflicting-resume.sh", "host"),
      ],
    }),
    entry("test/e2e/test-launchable-smoke.sh", "installer.launchable.smoke", {
      manifest: { scenarioId: "brev-launchable-cloud-openclaw", installSource: "launchable" },
      fixtures: ["launchable-clone", "launchable-sentinel"],
      actions: ["install.launchable", "onboard.openclaw"],
      assertions: [
        assertion("installer.launchable.artifacts", "validation_suites/installer/launchable/00-artifacts.sh", "host"),
        assertion("installer.launchable.sentinel-ready", "validation_suites/installer/launchable/01-sentinel-ready.sh", "host"),
      ],
    }),
    entry("test/e2e/test-spark-install.sh", "installer.dgx-spark.setup-only", {
      noManifestReason: "setup-only installer scenario for DGX Spark host",
      manifest: undefined,
      fixtures: ["spark-host-preflight", "public-installer-ref"],
      actions: ["install.public-curl"],
      assertions: [
        assertion("installer.spark.install-source-ref", "validation_suites/installer/spark/00-install-source-ref.sh", "host"),
        assertion("installer.spark.cli-available", "validation_suites/installer/spark/01-cli-available.sh", "host"),
      ],
    }),
  ];
}

function entry(
  legacyScript: string,
  assertionId: string,
  opts: {
    manifest?: Record<string, unknown>;
    noManifestReason?: string;
    fixtures: string[];
    actions: string[];
    assertions: ScenarioContractAssertion[];
  },
): ParityInventoryEntry {
  return {
    legacyScript,
    assertionId,
    owner: "scenario-framework",
    sourceAudit: `${AUDIT}#top-level-e2e-assertion-audit`,
    status: "mapped-hermetic",
    contract: {
      environment: { os: "ubuntu", runner: "e2e", requirements: ["docker", "node", "bash"] },
      ...(opts.manifest ? { manifest: opts.manifest } : {}),
      ...(opts.noManifestReason ? { noManifestReason: opts.noManifestReason } : {}),
      fixtures: opts.fixtures.map((id) => ({ id, cleanup: "teardown" })),
      runtimeActions: opts.actions.map((id, index) => ({ id, order: index + 1 })),
      assertions: opts.assertions,
    },
  };
}

function assertion(
  assertionId: string,
  implementation: string,
  boundary: ScenarioContractAssertion["boundary"],
): ScenarioContractAssertion {
  return {
    assertionId,
    implementation,
    evidencePath: `.e2e/assertions/${assertionId}.json`,
    boundary,
  };
}
