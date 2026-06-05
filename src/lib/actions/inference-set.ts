// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";

import { runOpenshell } from "../adapters/openshell/runtime";
import { CLI_NAME } from "../cli/branding";
import {
  getProviderSelectionConfig,
  getSandboxInferenceConfig,
  type SandboxInferenceConfig,
} from "../inference/config";
import {
  type AgentConfigTarget,
  readSandboxConfig,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  writeSandboxConfig,
} from "../sandbox/config";
import type { ConfigObject, ConfigValue } from "../security/credential-filter";
import { isConfigObject, isConfigValue } from "../security/credential-filter";
import { appendAuditEntry } from "../shields/audit";
import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { isSafeModelId } from "../validation";

export interface InferenceSetOptions {
  provider: string;
  model: string;
  sandboxName?: string | null;
  noVerify?: boolean;
}

export interface InferenceSetResult {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  providerKey: string;
  configChanged: boolean;
  sessionUpdated: boolean;
  inSandboxConfigSynced: boolean;
}

type OpenshellRunResult = Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;
type InferenceApi = "openai-completions" | "anthropic-messages" | "openai-responses";

export interface InferenceSetDeps {
  getDefaultSandbox: () => string | null;
  getSandbox: (name: string) => SandboxEntry | null;
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox: string | null };
  updateSandbox: (name: string, updates: Partial<SandboxEntry>) => boolean;
  getRequestedAgent: () => string | null | undefined;
  loadSession: () => onboardSession.Session | null;
  updateSession: (
    mutator: (session: onboardSession.Session) => onboardSession.Session | void,
  ) => onboardSession.Session;
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  readSandboxConfig: (sandboxName: string, target: AgentConfigTarget) => ConfigObject;
  writeSandboxConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
    config: ConfigObject,
  ) => void;
  recomputeSandboxConfigHash: (sandboxName: string, target: AgentConfigTarget) => void;
  runOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => OpenshellRunResult;
  appendAuditEntry: typeof appendAuditEntry;
  log: (message: string) => void;
}

export class InferenceSetError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InferenceSetError";
  }
}

const SUPPORTED_PROVIDER_NAMES = [
  "nvidia-prod",
  "nvidia-nim",
  "nvidia-router",
  "openai-api",
  "anthropic-prod",
  "compatible-anthropic-endpoint",
  "gemini-api",
  "compatible-endpoint",
  "hermes-provider",
  "ollama-local",
  "vllm-local",
] as const;

const SUPPORTED_INFERENCE_APIS = new Set<InferenceApi>([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

function defaultDeps(): InferenceSetDeps {
  return {
    getDefaultSandbox: registry.getDefault,
    getSandbox: registry.getSandbox,
    listSandboxes: registry.listSandboxes,
    updateSandbox: registry.updateSandbox,
    getRequestedAgent: () => process.env.NEMOCLAW_AGENT,
    loadSession: onboardSession.loadSession,
    updateSession: onboardSession.updateSession,
    resolveAgentConfig,
    readSandboxConfig,
    writeSandboxConfig,
    recomputeSandboxConfigHash,
    runOpenshell: (args, opts) => runOpenshell(args, opts),
    appendAuditEntry,
    log: console.log,
  };
}

function trimRequired(value: string | null | undefined, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new InferenceSetError(`${label} is required.`);
  return trimmed;
}

function assertSupportedProvider(provider: string, model: string): void {
  if (getProviderSelectionConfig(provider, model) || provider === "nvidia-router") return;
  throw new InferenceSetError(
    `Unsupported provider '${provider}'. Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`,
    2,
  );
}

function normalizeSandboxAgent(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return (trimmed || "openclaw").toLowerCase();
}

function resolveTargetSandbox(
  sandboxName: string | null | undefined,
  deps: Pick<
    InferenceSetDeps,
    "getDefaultSandbox" | "getSandbox" | "listSandboxes" | "getRequestedAgent"
  >,
): { sandboxName: string; entry: SandboxEntry; agentName: string } {
  const explicitName = sandboxName?.trim();
  if (explicitName) {
    const entry = deps.getSandbox(explicitName);
    if (!entry) {
      throw new InferenceSetError(`Sandbox '${explicitName}' is not registered.`, 2);
    }
    return {
      sandboxName: explicitName,
      entry,
      agentName: normalizeSandboxAgent(entry.agent),
    };
  }

  if (normalizeSandboxAgent(deps.getRequestedAgent()) === "hermes") {
    const hermesSandboxes = deps
      .listSandboxes()
      .sandboxes.filter((entry) => normalizeSandboxAgent(entry.agent) === "hermes");
    if (hermesSandboxes.length === 1) {
      const entry = hermesSandboxes[0];
      return { sandboxName: entry.name, entry, agentName: "hermes" };
    }
    if (hermesSandboxes.length === 0) {
      throw new InferenceSetError(
        "No registered Hermes sandbox found. Pass --sandbox <name> to target a sandbox explicitly.",
        2,
      );
    }
    throw new InferenceSetError(
      `Multiple Hermes sandboxes are registered (${hermesSandboxes
        .map((entry) => entry.name)
        .join(", ")}). Pass --sandbox <name> to choose one.`,
      2,
    );
  }

  const targetName = deps.getDefaultSandbox();
  if (!targetName) {
    throw new InferenceSetError(
      "No sandbox selected. Pass --sandbox <name> or create a sandbox with nemoclaw onboard.",
      2,
    );
  }

  const entry = deps.getSandbox(targetName);
  if (!entry) {
    throw new InferenceSetError(`Sandbox '${targetName}' is not registered.`, 2);
  }
  return { sandboxName: targetName, entry, agentName: normalizeSandboxAgent(entry.agent) };
}

function ensureObject(record: ConfigObject, key: string): ConfigObject {
  const existing = record[key];
  if (isConfigObject(existing)) return existing;
  const created: ConfigObject = {};
  record[key] = created;
  return created;
}

function cloneConfigObject(value: ConfigValue | undefined): ConfigObject {
  if (!isConfigObject(value)) return {};
  return { ...value };
}

function asConfigObject(value: Record<string, unknown>): ConfigObject {
  const result: ConfigObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isConfigValue(entry as ConfigValue)) result[key] = entry as ConfigValue;
  }
  return result;
}

function normalizeInferenceApi(value: unknown): InferenceApi | null {
  return typeof value === "string" && SUPPORTED_INFERENCE_APIS.has(value as InferenceApi)
    ? (value as InferenceApi)
    : null;
}

function readProviderApi(config: ConfigObject, providerKey: string): InferenceApi | null {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers)) return null;
  const provider = providers[providerKey];
  if (!isConfigObject(provider)) return null;
  return normalizeInferenceApi(provider.api);
}

function readOpenClawRouteApi(config: ConfigObject, provider: string): InferenceApi | null {
  if (provider === "anthropic-prod") return readProviderApi(config, "anthropic");
  if (provider === "compatible-anthropic-endpoint") {
    return readProviderApi(config, "anthropic") || readProviderApi(config, "inference");
  }
  return readProviderApi(config, getSandboxInferenceConfig("", provider).providerKey);
}

function readHermesRouteApi(config: ConfigObject): InferenceApi | null {
  const model = config.model;
  if (!isConfigObject(model)) return null;
  switch (model.api_mode) {
    case "anthropic_messages":
      return "anthropic-messages";
    case "codex_responses":
      return "openai-responses";
    case undefined:
    case null:
    case "":
      return "openai-completions";
    default:
      return null;
  }
}

function sessionRouteApi(
  session: onboardSession.Session | null,
  sandboxName: string,
  provider: string,
): InferenceApi | null {
  if (!session || session.sandboxName !== sandboxName || session.provider !== provider) return null;
  return normalizeInferenceApi(session.preferredInferenceApi);
}

function resolveRuntimeInferenceApi(options: {
  agentName: string;
  config: ConfigObject;
  currentProvider: string | null | undefined;
  provider: string;
  sandboxName: string;
  session: onboardSession.Session | null;
}): InferenceApi | null {
  const { agentName, config, currentProvider, provider, sandboxName, session } = options;
  if (provider === "anthropic-prod") return "anthropic-messages";

  const sameProvider = currentProvider === provider;
  const sessionApi = sameProvider ? sessionRouteApi(session, sandboxName, provider) : null;
  if (sessionApi) return sessionApi;

  const configApi =
    sameProvider && agentName === "hermes"
      ? readHermesRouteApi(config)
      : sameProvider
        ? readOpenClawRouteApi(config, provider)
        : null;
  if (configApi) return configApi;

  if (provider === "compatible-anthropic-endpoint") return "anthropic-messages";
  return null;
}

function hermesApiMode(inferenceApi: string): string | null {
  switch (inferenceApi) {
    case "":
    case "openai-completions":
      return null;
    case "anthropic-messages":
      return "anthropic_messages";
    case "openai-responses":
      return "codex_responses";
    default:
      return null;
  }
}

function updateAgentPrimary(config: ConfigObject, primaryModelRef: string): void {
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const model = ensureObject(defaults, "model");
  model.primary = primaryModelRef;
}

function buildProviderConfig(
  existing: ConfigObject,
  model: string,
  route: SandboxInferenceConfig,
): ConfigObject {
  const firstExistingModel = Array.isArray(existing.models)
    ? cloneConfigObject(existing.models[0])
    : {};
  delete firstExistingModel.compat;
  firstExistingModel.id = model;
  firstExistingModel.name = route.primaryModelRef;
  if (route.inferenceCompat) {
    firstExistingModel.compat = asConfigObject(route.inferenceCompat);
  }

  return {
    ...existing,
    baseUrl: route.inferenceBaseUrl,
    apiKey: typeof existing.apiKey === "string" && existing.apiKey ? existing.apiKey : "unused",
    api: route.inferenceApi,
    models: [firstExistingModel],
  };
}

export function patchOpenClawInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);

  updateAgentPrimary(config, route.primaryModelRef);

  const models = ensureObject(config, "models");
  models.mode = "merge";
  const providers = ensureObject(models, "providers");
  const existingProvider = cloneConfigObject(providers[route.providerKey]);
  providers[route.providerKey] = buildProviderConfig(existingProvider, model, route);

  return { changed: before !== JSON.stringify(config), route };
}

export function patchHermesInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  const modelConfig = ensureObject(config, "model");
  modelConfig.default = model;
  modelConfig.base_url = route.inferenceBaseUrl;
  modelConfig.provider = "custom";
  const apiMode = hermesApiMode(route.inferenceApi);
  if (apiMode) {
    modelConfig.api_mode = apiMode;
  } else {
    delete modelConfig.api_mode;
  }

  return { changed: before !== JSON.stringify(config), route };
}

function updateMatchingOnboardSession(
  sandboxName: string,
  provider: string,
  model: string,
  route: SandboxInferenceConfig,
  deps: Pick<InferenceSetDeps, "loadSession" | "updateSession">,
): boolean {
  const session = deps.loadSession();
  if (!session || session.sandboxName !== sandboxName) return false;
  deps.updateSession((current) => {
    if (current.sandboxName !== sandboxName) return current;
    current.provider = provider;
    current.model = model;
    current.endpointUrl =
      getProviderSelectionConfig(provider, model)?.endpointUrl ?? current.endpointUrl;
    current.preferredInferenceApi = route.inferenceApi;
    return current;
  });
  return true;
}

function openshellInferenceSetArgs(options: {
  provider: string;
  model: string;
  noVerify?: boolean;
}): string[] {
  const args = [
    "inference",
    "set",
    "-g",
    "nemoclaw",
    "--provider",
    options.provider,
    "--model",
    options.model,
  ];
  if (options.noVerify) args.push("--no-verify");
  return args;
}

function getPreferredInferenceApi(config: ConfigObject): string | null {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers)) return null;
  const inferenceProvider = providers.inference;
  if (!isConfigObject(inferenceProvider)) return null;
  return typeof inferenceProvider.api === "string" ? inferenceProvider.api : null;
}

export async function runInferenceSet(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = defaultDeps(),
): Promise<InferenceSetResult> {
  const provider = trimRequired(options.provider, "provider");
  const model = trimRequired(options.model, "model");
  assertSupportedProvider(provider, model);
  if (!isSafeModelId(model)) {
    throw new InferenceSetError(
      "Invalid model id. Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      2,
    );
  }

  const { sandboxName, entry, agentName } = resolveTargetSandbox(options.sandboxName, deps);
  if (agentName !== "openclaw" && agentName !== "hermes") {
    throw new InferenceSetError(
      `nemoclaw inference set supports OpenClaw and Hermes sandboxes; '${sandboxName}' uses '${agentName}'.`,
      2,
    );
  }
  const target = deps.resolveAgentConfig(sandboxName);
  const targetAgent = normalizeSandboxAgent(target.agentName);
  if (targetAgent !== agentName) {
    throw new InferenceSetError(
      `Sandbox '${sandboxName}' is registered as '${agentName}' but resolved config for '${target.agentName}'.`,
      2,
    );
  }

  deps.log(`  Setting OpenShell inference route: ${provider} / ${model}`);
  const setResult = deps.runOpenshell(
    openshellInferenceSetArgs({ provider, model, noVerify: options.noVerify }),
    {
      ignoreError: true,
    },
  );
  if (setResult.status !== 0) {
    throw new InferenceSetError(
      `OpenShell inference route update failed with exit ${setResult.status ?? 1}.`,
      setResult.status ?? 1,
    );
  }

  // Write the registry before the crash-prone in-sandbox sync so the gateway
  // and registry can't end up split (#3725) and trigger a revert on connect (#3726).
  if (!deps.updateSandbox(sandboxName, { provider, model })) {
    throw new InferenceSetError(`Failed to update NemoClaw registry for sandbox '${sandboxName}'.`);
  }

  const config = deps.readSandboxConfig(sandboxName, target);
  const preferredInferenceApi = resolveRuntimeInferenceApi({
    agentName,
    config,
    currentProvider: entry.provider,
    provider,
    sandboxName,
    session: deps.loadSession(),
  });
  const patched =
    agentName === "hermes"
      ? patchHermesInferenceConfig(config, provider, model, preferredInferenceApi)
      : patchOpenClawInferenceConfig(
          config,
          provider,
          model,
          preferredInferenceApi || getPreferredInferenceApi(config),
        );

  deps.log(
    agentName === "hermes"
      ? `  Syncing Hermes model route in sandbox '${sandboxName}'...`
      : `  Syncing OpenClaw model identity in sandbox '${sandboxName}'...`,
  );
  // In-sandbox config is the last, crash-prone layer (gateway + registry already consistent):
  //   - don't abort on failure; track whether it synced, never report a false "synced"
  // Two degraded states, both fixed by `rebuild` (regenerates openclaw.json + .config-hash from registry):
  //   - write fails:           config left old (old .config-hash still matches it)
  //   - hash recompute fails:  config new but .config-hash stale -> integrity-guard mismatch
  let inSandboxConfigSynced = false;
  try {
    deps.writeSandboxConfig(sandboxName, target, config);
    try {
      deps.recomputeSandboxConfigHash(sandboxName, target);
      inSandboxConfigSynced = true;
    } catch (hashError) {
      const detail =
        hashError instanceof Error && hashError.message ? hashError.message : String(hashError);
      deps.log(
        `  Warning: wrote the in-sandbox config for '${sandboxName}' but failed to refresh its ` +
          `integrity hash: ${detail}`,
      );
      deps.log(`  Run '${CLI_NAME} ${sandboxName} rebuild' to resync the in-sandbox config.`);
    }
  } catch (writeError) {
    const detail =
      writeError instanceof Error && writeError.message ? writeError.message : String(writeError);
    deps.log(
      `  Warning: gateway and registry now use ${provider} / ${model}, but writing the ` +
        `in-sandbox config failed: ${detail}`,
    );
    deps.log(
      `  Run '${CLI_NAME} ${sandboxName} rebuild' to finish applying the model inside the sandbox.`,
    );
  }
  const sessionUpdated = updateMatchingOnboardSession(sandboxName, provider, model, patched.route, deps);

  deps.appendAuditEntry({
    action: "inference_set",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set ${agentName}:${provider}:${model}${
      inSandboxConfigSynced ? "" : " (in-sandbox sync incomplete)"
    }`,
  });

  // Only claim "synced" when the in-sandbox layer actually synced; otherwise the
  // warning above already described the degraded state.
  if (inSandboxConfigSynced) {
    deps.log(
      agentName === "hermes"
        ? `  Inference route synced for '${sandboxName}': ${model}`
        : `  Inference route synced for '${sandboxName}': ${patched.route.primaryModelRef}`,
    );
  }

  return {
    sandboxName,
    provider,
    model,
    primaryModelRef: patched.route.primaryModelRef,
    providerKey: patched.route.providerKey,
    configChanged: patched.changed,
    sessionUpdated,
    inSandboxConfigSynced,
  };
}
