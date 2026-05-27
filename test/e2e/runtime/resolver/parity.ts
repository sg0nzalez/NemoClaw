// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity inventory contracts for mapping legacy top-level E2E assertions to
 * the scenario framework. These helpers intentionally treat preview/plan
 * metadata as discoverability only: mapped parity requires setup contracts,
 * executable assertion steps, stable assertion ids, and evidence paths.
 */

export const PARITY_STATUSES = [
  "mapped-live",
  "mapped-hermetic",
  "partial",
  "metadata-only",
  "retired",
  "deferred",
] as const;
export type ParityStatus = (typeof PARITY_STATUSES)[number];

const MAPPED_STATUSES = new Set<ParityStatus>(["mapped-live", "mapped-hermetic"]);
const INCOMPLETE_STATUSES = new Set<ParityStatus>(["partial", "metadata-only", "deferred"]);
const DANGEROUS_FIXTURE_TYPES = new Set([
  "docker-daemon-mutation",
  "hosts-edit",
  "policy-mutation",
  "blueprint-mutation",
  "image-mutation",
]);
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential)/i;
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9]{16,}|nvapi-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;

export interface ScenarioContractAssertion {
  assertionId: string;
  implementation: string;
  evidencePath: string;
  boundary: "live" | "sandbox" | "host" | "fake-service" | "metadata" | string;
  previewOnly?: boolean;
  pending?: boolean;
  genericHealthOnly?: boolean;
}

export interface ScenarioContractFixture {
  id: string;
  type?: string;
  cleanup?: string;
  restore?: string;
  [key: string]: unknown;
}

export interface ScenarioContractRuntimeAction {
  id: string;
  order: number;
  evidencePath?: string;
  [key: string]: unknown;
}

export interface ScenarioContract {
  environment?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  noManifestReason?: string;
  fixtures?: ScenarioContractFixture[];
  runtimeActions?: ScenarioContractRuntimeAction[];
  assertions?: ScenarioContractAssertion[];
}

export interface ParityInventoryEntry {
  legacyScript: string;
  assertionId: string;
  owner: string;
  sourceAudit: string;
  status: ParityStatus;
  contract?: ScenarioContract;
  rationale?: string;
}

export interface ParityInventoryValidationResult {
  ok: boolean;
  complete: boolean;
  errors: string[];
}

export interface ParityInventoryValidationInput {
  entries: ParityInventoryEntry[];
  requiredLegacyScripts?: string[];
  sourceRoot?: string;
}

export function inferPreviewParityStatus(contract: ScenarioContract): ParityStatus {
  const assertions = contract.assertions ?? [];
  if (assertions.length === 0 || assertions.every((assertion) => assertion.previewOnly)) {
    return "metadata-only";
  }
  return "partial";
}

export function validateParityInventory(
  input: ParityInventoryValidationInput,
): ParityInventoryValidationResult {
  const errors: string[] = [];
  const seenScripts = new Set<string>();

  for (const [index, entry] of input.entries.entries()) {
    const label = entryLabel(entry, index);
    seenScripts.add(entry.legacyScript);

    if (!PARITY_STATUSES.includes(entry.status)) {
      errors.push(`${label}: unsupported parity status '${String(entry.status)}'`);
      continue;
    }
    if (!entry.legacyScript) errors.push(`${label}: legacyScript is required`);
    if (!entry.assertionId) errors.push(`${label}: assertionId is required`);
    if (!entry.owner) errors.push(`${label}: owner is required`);
    if (!entry.sourceAudit) errors.push(`${label}: sourceAudit is required`);

    validateNoRawSecrets(entry, label, errors);

    if (entry.status === "retired") {
      if (!entry.rationale?.trim()) {
        errors.push(`${label}: retired parity entry requires rationale`);
      }
      continue;
    }

    if (MAPPED_STATUSES.has(entry.status)) {
      validateMappedEntry(entry, label, errors);
    }

    for (const fixture of entry.contract?.fixtures ?? []) {
      if (isDangerousFixture(fixture) && !fixture.cleanup && !fixture.restore) {
        errors.push(
          `${label}: dangerous fixture '${fixture.id}' requires cleanup or restore obligation`,
        );
      }
    }
  }

  for (const script of input.requiredLegacyScripts ?? []) {
    if (!seenScripts.has(script)) {
      errors.push(`${script}: missing parity inventory entry`);
    }
  }

  return {
    ok: errors.length === 0,
    complete: errors.length === 0 && input.entries.every((entry) => isCompleteStatus(entry)),
    errors,
  };
}

function validateMappedEntry(
  entry: ParityInventoryEntry,
  label: string,
  errors: string[],
): void {
  const contract = entry.contract;
  if (!contract) {
    errors.push(`${label}: mapped parity requires scenario contract`);
    return;
  }
  if (!contract.environment) {
    errors.push(`${label}: missing contract part: environment`);
  }
  if (!contract.manifest && !contract.noManifestReason) {
    errors.push(`${label}: missing contract part: manifest or noManifestReason`);
  }
  const assertions = contract.assertions ?? [];
  if (assertions.length === 0) {
    errors.push(`${label}: mapped parity requires at least one real assertion step`);
  }
  for (const [index, assertion] of assertions.entries()) {
    const assertionLabel = `${label}.assertions[${index}]`;
    if (!assertion.assertionId?.trim()) {
      errors.push(`${assertionLabel}: stable assertionId is required`);
    }
    if (!assertion.evidencePath?.trim()) {
      errors.push(`${assertionLabel}: evidencePath is required`);
    }
    if (!assertion.implementation?.trim()) {
      errors.push(`${assertionLabel}: assertion implementation is required`);
    }
    if (assertion.previewOnly || assertion.boundary === "metadata") {
      errors.push(`${assertionLabel}: preview/metadata-only assertion is not a real assertion step`);
    }
    if (assertion.pending || /(^|\W)(pendingStep|TODO|no-op)(\W|$)/i.test(assertion.implementation)) {
      errors.push(`${assertionLabel}: pending steps, TODOs, and no-op probes cannot be mapped parity`);
    }
    if (assertion.genericHealthOnly) {
      errors.push(`${assertionLabel}: generic health-only assertion cannot satisfy mapped parity`);
    }
  }
}

function isCompleteStatus(entry: ParityInventoryEntry): boolean {
  if (entry.status === "retired") return Boolean(entry.rationale?.trim());
  if (INCOMPLETE_STATUSES.has(entry.status)) return false;
  return MAPPED_STATUSES.has(entry.status);
}

function isDangerousFixture(fixture: ScenarioContractFixture): boolean {
  return Boolean(fixture.type && DANGEROUS_FIXTURE_TYPES.has(fixture.type));
}

function entryLabel(entry: ParityInventoryEntry, index: number): string {
  return `${entry.legacyScript || `<entry ${index}>`}#${entry.assertionId || "<missing-assertion>"}`;
}

function validateNoRawSecrets(value: unknown, label: string, errors: string[]): void {
  const visit = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (SECRET_VALUE_PATTERN.test(node)) {
        errors.push(`${label}: raw secret-like value at ${path}`);
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (SECRET_KEY_PATTERN.test(key) && typeof child === "string" && !isSecretReference(child)) {
        errors.push(`${label}: raw secret-like value at ${nextPath}`);
      }
      visit(child, nextPath);
    }
  };
  visit(value, "entry");
}

function isSecretReference(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value) || /^\$\{[A-Z][A-Z0-9_]+\}$/.test(value);
}

export function renderLegacyContractCoverageReport(entries: ParityInventoryEntry[]): string {
  const lines = [
    "# Legacy E2E Contract Coverage",
    "",
    "| Legacy script | Environment | Manifest/no-manifest | Fixtures | Runtime actions | Assertions | Status |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const entry of [...entries].sort((a, b) => {
    const scriptCompare = a.legacyScript.localeCompare(b.legacyScript);
    return scriptCompare || a.assertionId.localeCompare(b.assertionId);
  })) {
    const contract = entry.contract ?? {};
    lines.push(
      `| ${entry.legacyScript} | ${yesNo(contract.environment)} | ${manifestCell(contract)} | ${(contract.fixtures ?? []).length} | ${(contract.runtimeActions ?? []).length} | ${(contract.assertions ?? []).length} | ${entry.status} |`,
    );
  }
  return lines.join("\n");
}

function yesNo(value: unknown): string {
  return value ? "yes" : "no";
}

function manifestCell(contract: ScenarioContract): string {
  if (contract.manifest) return "manifest";
  if (contract.noManifestReason) return `no manifest: ${contract.noManifestReason}`;
  return "missing";
}
