// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { EXACT_IMAGE_STAGING_FAMILY } from "./exact-image-manifest.mts";

export const BREV_LAUNCHABLE_WORKSPACE_RECEIPT_KIND = "nemoclaw-brev-launchable-workspace-receipt";
export const BREV_WORKSPACE_CLEANUP_EVIDENCE_KIND = "nemoclaw-brev-workspace-cleanup-evidence";

export type BrevLaunchableWorkspaceFailureCode =
  | "REQUEST_INVALID"
  | "ARTIFACT_MISSING_OR_INVALID"
  | "PROVENANCE_MISMATCH"
  | "BREV_IMAGE_RESOLUTION_MISMATCH"
  | "BREV_READINESS_FAILED"
  | "BREV_CLEANUP_INCOMPLETE"
  | "UNKNOWN";

export class BrevLaunchableWorkspaceError extends Error {
  readonly code: BrevLaunchableWorkspaceFailureCode;

  constructor(code: BrevLaunchableWorkspaceFailureCode, message: string) {
    super(message);
    this.name = "BrevLaunchableWorkspaceError";
    this.code = code;
  }
}

export type BrevImageIdentity = {
  project: string;
  imageName: string;
  imageId: string;
  imageSelfLink: string;
};

// resolvedImage and bootImage are independently observed Brev/platform
// readbacks. A transport adapter must never populate either object by copying
// the accepted manifest or the supplied Launchable configuration.
export type BrevLaunchableWorkspaceReceipt = {
  schemaVersion: 1;
  kind: typeof BREV_LAUNCHABLE_WORKSPACE_RECEIPT_KIND;
  correlationId: string;
  nemoclawSha: string;
  acceptedImageManifestSha256: string;
  organizationId: string;
  idempotencyKey: string;
  launchable: {
    id: string;
    revision: string;
    suppliedImageReference: string;
    resolvedImage: BrevImageIdentity;
  };
  workspace: {
    id: string;
    launchableId: string;
    launchableRevision: string;
    bootImage: BrevImageIdentity;
    status: "READY";
  };
  recordedAt: string;
};

export type BrevLaunchableWorkspaceReceiptExpectations = {
  correlationId: string;
  nemoclawSha: string;
  // Hash of the normalized manifest already accepted by the image controller.
  acceptedImageManifestSha256: string;
  organizationId: string;
  idempotencyKey: string;
  // These generated identities must come from separately persisted,
  // authoritative Brev operation results. Never derive them from the receipt
  // being validated.
  launchableId: string;
  launchableRevision: string;
  workspaceId: string;
  suppliedImageReference: string;
  image: BrevImageIdentity;
  notBeforeMs: number;
  notAfterMs: number;
};

export type BrevWorkspaceCleanupEvidence = {
  schemaVersion: 1;
  kind: typeof BREV_WORKSPACE_CLEANUP_EVIDENCE_KIND;
  correlationId: string;
  receiptSha256: string;
  organizationId: string;
  workspaceId: string;
  launchableId: string;
  launchableRevision: string;
  deleteRequestedAt: string;
  terminalState: "ABSENT";
  verifiedAt: string;
};

export type BrevWorkspaceCleanupEvidenceExpectations = {
  // The controller persists this full tuple before issuing delete. Cleanup
  // validation must not derive it from the cleanup artifact being validated.
  correlationId: string;
  receiptSha256: string;
  organizationId: string;
  workspaceId: string;
  launchableId: string;
  launchableRevision: string;
  notBeforeMs: number;
  notAfterMs: number;
};

const RECEIPT_FIELDS = [
  "schemaVersion",
  "kind",
  "correlationId",
  "nemoclawSha",
  "acceptedImageManifestSha256",
  "organizationId",
  "idempotencyKey",
  "launchable",
  "workspace",
  "recordedAt",
] as const;
const LAUNCHABLE_FIELDS = ["id", "revision", "suppliedImageReference", "resolvedImage"] as const;
const WORKSPACE_FIELDS = [
  "id",
  "launchableId",
  "launchableRevision",
  "bootImage",
  "status",
] as const;
const IMAGE_FIELDS = ["project", "imageName", "imageId", "imageSelfLink"] as const;
const CLEANUP_FIELDS = [
  "schemaVersion",
  "kind",
  "correlationId",
  "receiptSha256",
  "organizationId",
  "workspaceId",
  "launchableId",
  "launchableRevision",
  "deleteRequestedAt",
  "terminalState",
  "verifiedAt",
] as const;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u;
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const IMAGE_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const CANONICAL_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)[.](\d{3})Z$/u;
const OPAQUE_ID_MAX_BYTES = 256;
const REVISION_MAX_BYTES = 512;
const IMAGE_REFERENCE_MAX_BYTES = 2_048;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 6;

function fail(code: BrevLaunchableWorkspaceFailureCode, message: string): never {
  throw new BrevLaunchableWorkspaceError(code, message);
}

function requireRecord(
  value: unknown,
  label: string,
  code: BrevLaunchableWorkspaceFailureCode = "ARTIFACT_MISSING_OR_INVALID",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validateExactFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const expected = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      fail("ARTIFACT_MISSING_OR_INVALID", `${label} is missing required field ${field}`);
    }
  }
  const unexpected = Object.keys(record)
    .filter((field) => !expected.has(field))
    .sort();
  if (unexpected.length > 0) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${label} contains unexpected field ${unexpected[0]}`);
  }
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    fail("ARTIFACT_MISSING_OR_INVALID", `${label}.${field} must be a string`);
  }
  return value;
}

function requireConstant<T extends string | number>(
  actual: unknown,
  expected: T,
  field: string,
  code: BrevLaunchableWorkspaceFailureCode = "PROVENANCE_MISMATCH",
): asserts actual is T {
  if (actual !== expected) {
    fail(code, `${field} must equal ${JSON.stringify(expected)}`);
  }
}

function requirePattern(
  value: unknown,
  field: string,
  pattern: RegExp,
  code: BrevLaunchableWorkspaceFailureCode = "ARTIFACT_MISSING_OR_INVALID",
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, `${field} has an invalid format`);
  }
}

function requireOpaqueAscii(
  value: unknown,
  field: string,
  maxBytes: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxBytes ||
    value !== value.trim() ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    fail(
      "ARTIFACT_MISSING_OR_INVALID",
      `${field} must be 1-${maxBytes} bytes of trimmed printable ASCII`,
    );
  }
}

function parseCanonicalUtc(value: string, field: string): number {
  if (!CANONICAL_UTC_PATTERN.test(value)) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be a canonical UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be a real canonical UTC timestamp`);
  }
  return timestamp;
}

function parseStrictEvidenceJson(contents: string, label: string): unknown {
  if (Buffer.byteLength(contents, "utf8") > MAX_EVIDENCE_BYTES) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${label} exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  }

  let position = 0;
  const invalid = (message: string): never =>
    fail("ARTIFACT_MISSING_OR_INVALID", `${label} ${message}`);
  const skipWhitespace = (): void => {
    while (
      contents[position] === " " ||
      contents[position] === "\t" ||
      contents[position] === "\r" ||
      contents[position] === "\n"
    ) {
      position += 1;
    }
  };
  const scanString = (): string => {
    const start = position;
    if (contents[position] !== '"') invalid("is not valid JSON");
    position += 1;
    while (position < contents.length) {
      const character = contents[position];
      if (character === '"') {
        position += 1;
        try {
          const decoded = JSON.parse(contents.slice(start, position)) as unknown;
          if (typeof decoded === "string") return decoded;
          return invalid("is not valid JSON");
        } catch {
          invalid("is not valid JSON");
        }
      }
      if (character === "\\") {
        position += 2;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        invalid("is not valid JSON");
      }
      position += 1;
    }
    return invalid("is not valid JSON");
  };

  const scanValue = (containerDepth: number): void => {
    skipWhitespace();
    const character = contents[position];
    if (character === '"') {
      scanString();
      return;
    }
    if (character === "{" || character === "[") {
      if (containerDepth >= MAX_JSON_DEPTH) {
        invalid(`exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}`);
      }
      const closing = character === "{" ? "}" : "]";
      const objectKeys = character === "{" ? new Set<string>() : null;
      position += 1;
      skipWhitespace();
      if (contents[position] === closing) {
        position += 1;
        return;
      }
      while (position < contents.length) {
        if (objectKeys) {
          if (contents[position] !== '"') invalid("is not valid JSON");
          const key = scanString();
          if (objectKeys.has(key)) invalid(`contains duplicate key ${JSON.stringify(key)}`);
          objectKeys.add(key);
          skipWhitespace();
          if (contents[position] !== ":") invalid("is not valid JSON");
          position += 1;
        }
        scanValue(containerDepth + 1);
        skipWhitespace();
        if (contents[position] === closing) {
          position += 1;
          return;
        }
        if (contents[position] !== ",") invalid("is not valid JSON");
        position += 1;
        skipWhitespace();
      }
      invalid("is not valid JSON");
    }

    const start = position;
    while (
      position < contents.length &&
      contents[position] !== " " &&
      contents[position] !== "\t" &&
      contents[position] !== "\r" &&
      contents[position] !== "\n" &&
      contents[position] !== "," &&
      contents[position] !== "]" &&
      contents[position] !== "}"
    ) {
      position += 1;
    }
    if (position === start) invalid("is not valid JSON");
  };

  scanValue(0);
  skipWhitespace();
  if (position !== contents.length) invalid("contains trailing transport output");
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return invalid("is not valid JSON");
  }
}

function validateWindow(notBeforeMs: number, notAfterMs: number): void {
  if (
    !Number.isSafeInteger(notBeforeMs) ||
    !Number.isSafeInteger(notAfterMs) ||
    notBeforeMs < 0 ||
    notAfterMs < notBeforeMs
  ) {
    fail("REQUEST_INVALID", "trusted evidence window is invalid");
  }
}

function requireWithinWindow(
  timestamp: number,
  notBeforeMs: number,
  notAfterMs: number,
  field: string,
): void {
  if (timestamp < notBeforeMs || timestamp > notAfterMs) {
    fail("PROVENANCE_MISMATCH", `${field} is outside the trusted evidence window`);
  }
}

function buildImageIdentity(value: unknown, label: string): BrevImageIdentity {
  const record = requireRecord(value, label);
  validateExactFields(record, IMAGE_FIELDS, label);
  const image: BrevImageIdentity = {
    project: requireString(record, "project", label),
    imageName: requireString(record, "imageName", label),
    imageId: requireString(record, "imageId", label),
    imageSelfLink: requireString(record, "imageSelfLink", label),
  };
  if (!GCP_PROJECT_ID_PATTERN.test(image.project)) {
    fail("BREV_IMAGE_RESOLUTION_MISMATCH", `${label}.project is not a canonical GCP project ID`);
  }
  requirePattern(
    image.imageName,
    `${label}.imageName`,
    IMAGE_NAME_PATTERN,
    "BREV_IMAGE_RESOLUTION_MISMATCH",
  );
  requirePattern(
    image.imageId,
    `${label}.imageId`,
    DECIMAL_ID_PATTERN,
    "BREV_IMAGE_RESOLUTION_MISMATCH",
  );
  const expectedSelfLink = `https://www.googleapis.com/compute/v1/projects/${image.project}/global/images/${image.imageName}`;
  if (image.imageSelfLink !== expectedSelfLink) {
    fail(
      "BREV_IMAGE_RESOLUTION_MISMATCH",
      `${label}.imageSelfLink does not exactly identify project/imageName`,
    );
  }
  return image;
}

function validateExpectedImage(image: BrevImageIdentity): void {
  try {
    buildImageIdentity(image, "expected image");
  } catch (error) {
    if (error instanceof BrevLaunchableWorkspaceError) {
      fail("REQUEST_INVALID", error.message);
    }
    throw error;
  }
}

function assertExpected(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail("PROVENANCE_MISMATCH", `${field} does not match trusted controller state`);
  }
}

function assertExpectedImage(
  actual: BrevImageIdentity,
  expected: BrevImageIdentity,
  label: string,
) {
  for (const field of IMAGE_FIELDS) {
    if (actual[field] !== expected[field]) {
      fail(
        "BREV_IMAGE_RESOLUTION_MISMATCH",
        `${label}.${field} does not match the accepted exact image manifest`,
      );
    }
  }
}

function validateReceiptExpectations(expected: BrevLaunchableWorkspaceReceiptExpectations): void {
  requirePattern(
    expected.correlationId,
    "expected correlationId",
    UUID_V4_PATTERN,
    "REQUEST_INVALID",
  );
  requirePattern(expected.nemoclawSha, "expected nemoclawSha", FULL_SHA_PATTERN, "REQUEST_INVALID");
  requirePattern(
    expected.acceptedImageManifestSha256,
    "expected acceptedImageManifestSha256",
    SHA256_PATTERN,
    "REQUEST_INVALID",
  );
  for (const [value, field, maxBytes] of [
    [expected.organizationId, "expected organizationId", OPAQUE_ID_MAX_BYTES],
    [expected.idempotencyKey, "expected idempotencyKey", OPAQUE_ID_MAX_BYTES],
    [expected.launchableId, "expected launchableId", OPAQUE_ID_MAX_BYTES],
    [expected.launchableRevision, "expected launchableRevision", REVISION_MAX_BYTES],
    [expected.workspaceId, "expected workspaceId", OPAQUE_ID_MAX_BYTES],
    [expected.suppliedImageReference, "expected suppliedImageReference", IMAGE_REFERENCE_MAX_BYTES],
  ] as const) {
    try {
      requireOpaqueAscii(value, field, maxBytes);
    } catch (error) {
      if (error instanceof BrevLaunchableWorkspaceError) fail("REQUEST_INVALID", error.message);
      throw error;
    }
  }
  validateExpectedImage(expected.image);
  const supportedFamilyReference = `projects/${expected.image.project}/global/images/family/${EXACT_IMAGE_STAGING_FAMILY}`;
  if (
    expected.suppliedImageReference !== expected.image.imageSelfLink &&
    expected.suppliedImageReference !== supportedFamilyReference
  ) {
    fail(
      "REQUEST_INVALID",
      "expected suppliedImageReference must be the accepted immutable self-link or canonical staging family",
    );
  }
  validateWindow(expected.notBeforeMs, expected.notAfterMs);
}

function buildReceipt(record: Record<string, unknown>): BrevLaunchableWorkspaceReceipt {
  requireConstant(record.schemaVersion, 1, "schemaVersion");
  requireConstant(record.kind, BREV_LAUNCHABLE_WORKSPACE_RECEIPT_KIND, "kind");

  const launchable = requireRecord(record.launchable, "launchable");
  validateExactFields(launchable, LAUNCHABLE_FIELDS, "launchable");
  const launchableId = requireString(launchable, "id", "launchable");
  const launchableRevision = requireString(launchable, "revision", "launchable");
  requireOpaqueAscii(launchableId, "launchable.id", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(launchableRevision, "launchable.revision", REVISION_MAX_BYTES);

  const workspace = requireRecord(record.workspace, "workspace");
  validateExactFields(workspace, WORKSPACE_FIELDS, "workspace");
  requireConstant(workspace.status, "READY", "workspace.status", "BREV_READINESS_FAILED");
  const workspaceId = requireString(workspace, "id", "workspace");
  const workspaceLaunchableId = requireString(workspace, "launchableId", "workspace");
  const workspaceLaunchableRevision = requireString(workspace, "launchableRevision", "workspace");
  requireOpaqueAscii(workspaceId, "workspace.id", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(workspaceLaunchableId, "workspace.launchableId", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(
    workspaceLaunchableRevision,
    "workspace.launchableRevision",
    REVISION_MAX_BYTES,
  );

  const receipt: BrevLaunchableWorkspaceReceipt = {
    schemaVersion: 1,
    kind: BREV_LAUNCHABLE_WORKSPACE_RECEIPT_KIND,
    correlationId: requireString(record, "correlationId", "receipt"),
    nemoclawSha: requireString(record, "nemoclawSha", "receipt"),
    acceptedImageManifestSha256: requireString(record, "acceptedImageManifestSha256", "receipt"),
    organizationId: requireString(record, "organizationId", "receipt"),
    idempotencyKey: requireString(record, "idempotencyKey", "receipt"),
    launchable: {
      id: launchableId,
      revision: launchableRevision,
      suppliedImageReference: requireString(launchable, "suppliedImageReference", "launchable"),
      resolvedImage: buildImageIdentity(launchable.resolvedImage, "launchable.resolvedImage"),
    },
    workspace: {
      id: workspaceId,
      launchableId: workspaceLaunchableId,
      launchableRevision: workspaceLaunchableRevision,
      bootImage: buildImageIdentity(workspace.bootImage, "workspace.bootImage"),
      status: "READY",
    },
    recordedAt: requireString(record, "recordedAt", "receipt"),
  };

  requirePattern(receipt.correlationId, "correlationId", UUID_V4_PATTERN);
  requirePattern(receipt.nemoclawSha, "nemoclawSha", FULL_SHA_PATTERN);
  requirePattern(
    receipt.acceptedImageManifestSha256,
    "acceptedImageManifestSha256",
    SHA256_PATTERN,
  );
  requireOpaqueAscii(receipt.organizationId, "organizationId", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(receipt.idempotencyKey, "idempotencyKey", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(
    receipt.launchable.suppliedImageReference,
    "launchable.suppliedImageReference",
    IMAGE_REFERENCE_MAX_BYTES,
  );
  parseCanonicalUtc(receipt.recordedAt, "recordedAt");
  return receipt;
}

export function validateBrevLaunchableWorkspaceReceipt(
  value: unknown,
  expected: BrevLaunchableWorkspaceReceiptExpectations,
): BrevLaunchableWorkspaceReceipt {
  // This is the normalized evidence boundary, not a Brev transport adapter.
  // Adapters must retain separate bounded raw-response hashes and populate
  // observed image/readiness fields only from authoritative platform readback.
  validateReceiptExpectations(expected);
  const record = requireRecord(value, "receipt");
  validateExactFields(record, RECEIPT_FIELDS, "receipt");
  const receipt = buildReceipt(record);

  for (const [actual, wanted, field] of [
    [receipt.correlationId, expected.correlationId, "correlationId"],
    [receipt.nemoclawSha, expected.nemoclawSha, "nemoclawSha"],
    [
      receipt.acceptedImageManifestSha256,
      expected.acceptedImageManifestSha256,
      "acceptedImageManifestSha256",
    ],
    [receipt.organizationId, expected.organizationId, "organizationId"],
    [receipt.idempotencyKey, expected.idempotencyKey, "idempotencyKey"],
    [receipt.launchable.id, expected.launchableId, "launchable.id"],
    [receipt.launchable.revision, expected.launchableRevision, "launchable.revision"],
    [receipt.workspace.id, expected.workspaceId, "workspace.id"],
    [
      receipt.launchable.suppliedImageReference,
      expected.suppliedImageReference,
      "launchable.suppliedImageReference",
    ],
  ] as const) {
    assertExpected(actual, wanted, field);
  }

  if (receipt.workspace.launchableId !== receipt.launchable.id) {
    fail(
      "PROVENANCE_MISMATCH",
      "workspace launchable ID does not match the provisioned Launchable",
    );
  }
  if (receipt.workspace.launchableRevision !== receipt.launchable.revision) {
    fail(
      "PROVENANCE_MISMATCH",
      "workspace Launchable revision does not match the immutable provisioned revision",
    );
  }
  assertExpectedImage(receipt.launchable.resolvedImage, expected.image, "launchable.resolvedImage");
  assertExpectedImage(receipt.workspace.bootImage, expected.image, "workspace.bootImage");

  const recordedAt = parseCanonicalUtc(receipt.recordedAt, "recordedAt");
  requireWithinWindow(recordedAt, expected.notBeforeMs, expected.notAfterMs, "recordedAt");
  return receipt;
}

export function parseBrevLaunchableWorkspaceReceiptJson(contents: string): unknown {
  return parseStrictEvidenceJson(contents, "receipt");
}

export function parseAndValidateBrevLaunchableWorkspaceReceipt(
  contents: string,
  expected: BrevLaunchableWorkspaceReceiptExpectations,
): BrevLaunchableWorkspaceReceipt {
  return validateBrevLaunchableWorkspaceReceipt(
    parseBrevLaunchableWorkspaceReceiptJson(contents),
    expected,
  );
}

export function normalizedBrevLaunchableWorkspaceReceiptJson(
  receipt: BrevLaunchableWorkspaceReceipt,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function brevLaunchableWorkspaceReceiptSha256(
  receipt: BrevLaunchableWorkspaceReceipt,
): string {
  return createHash("sha256")
    .update(normalizedBrevLaunchableWorkspaceReceiptJson(receipt))
    .digest("hex");
}

function validateCleanupExpectations(expected: BrevWorkspaceCleanupEvidenceExpectations): void {
  requirePattern(
    expected.correlationId,
    "expected correlationId",
    UUID_V4_PATTERN,
    "REQUEST_INVALID",
  );
  requirePattern(
    expected.receiptSha256,
    "expected receiptSha256",
    SHA256_PATTERN,
    "REQUEST_INVALID",
  );
  for (const [value, field, maxBytes] of [
    [expected.organizationId, "expected organizationId", OPAQUE_ID_MAX_BYTES],
    [expected.workspaceId, "expected workspaceId", OPAQUE_ID_MAX_BYTES],
    [expected.launchableId, "expected launchableId", OPAQUE_ID_MAX_BYTES],
    [expected.launchableRevision, "expected launchableRevision", REVISION_MAX_BYTES],
  ] as const) {
    try {
      requireOpaqueAscii(value, field, maxBytes);
    } catch (error) {
      if (error instanceof BrevLaunchableWorkspaceError) fail("REQUEST_INVALID", error.message);
      throw error;
    }
  }
  validateWindow(expected.notBeforeMs, expected.notAfterMs);
}

function buildCleanupEvidence(record: Record<string, unknown>): BrevWorkspaceCleanupEvidence {
  requireConstant(record.schemaVersion, 1, "schemaVersion");
  requireConstant(record.kind, BREV_WORKSPACE_CLEANUP_EVIDENCE_KIND, "kind");
  requireConstant(record.terminalState, "ABSENT", "terminalState", "BREV_CLEANUP_INCOMPLETE");
  const cleanup: BrevWorkspaceCleanupEvidence = {
    schemaVersion: 1,
    kind: BREV_WORKSPACE_CLEANUP_EVIDENCE_KIND,
    correlationId: requireString(record, "correlationId", "cleanup evidence"),
    receiptSha256: requireString(record, "receiptSha256", "cleanup evidence"),
    organizationId: requireString(record, "organizationId", "cleanup evidence"),
    workspaceId: requireString(record, "workspaceId", "cleanup evidence"),
    launchableId: requireString(record, "launchableId", "cleanup evidence"),
    launchableRevision: requireString(record, "launchableRevision", "cleanup evidence"),
    deleteRequestedAt: requireString(record, "deleteRequestedAt", "cleanup evidence"),
    terminalState: "ABSENT",
    verifiedAt: requireString(record, "verifiedAt", "cleanup evidence"),
  };
  requirePattern(cleanup.correlationId, "correlationId", UUID_V4_PATTERN);
  requirePattern(cleanup.receiptSha256, "receiptSha256", SHA256_PATTERN);
  requireOpaqueAscii(cleanup.organizationId, "organizationId", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(cleanup.workspaceId, "workspaceId", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(cleanup.launchableId, "launchableId", OPAQUE_ID_MAX_BYTES);
  requireOpaqueAscii(cleanup.launchableRevision, "launchableRevision", REVISION_MAX_BYTES);
  parseCanonicalUtc(cleanup.deleteRequestedAt, "deleteRequestedAt");
  parseCanonicalUtc(cleanup.verifiedAt, "verifiedAt");
  return cleanup;
}

export function validateBrevWorkspaceCleanupEvidence(
  value: unknown,
  expected: BrevWorkspaceCleanupEvidenceExpectations,
): BrevWorkspaceCleanupEvidence {
  validateCleanupExpectations(expected);
  const record = requireRecord(value, "cleanup evidence");
  validateExactFields(record, CLEANUP_FIELDS, "cleanup evidence");
  const cleanup = buildCleanupEvidence(record);

  for (const [actual, wanted, field] of [
    [cleanup.correlationId, expected.correlationId, "correlationId"],
    [cleanup.receiptSha256, expected.receiptSha256, "receiptSha256"],
    [cleanup.organizationId, expected.organizationId, "organizationId"],
    [cleanup.workspaceId, expected.workspaceId, "workspaceId"],
    [cleanup.launchableId, expected.launchableId, "launchableId"],
    [cleanup.launchableRevision, expected.launchableRevision, "launchableRevision"],
  ] as const) {
    assertExpected(actual, wanted, field);
  }

  const deleteRequestedAt = parseCanonicalUtc(cleanup.deleteRequestedAt, "deleteRequestedAt");
  const verifiedAt = parseCanonicalUtc(cleanup.verifiedAt, "verifiedAt");
  requireWithinWindow(
    deleteRequestedAt,
    expected.notBeforeMs,
    expected.notAfterMs,
    "deleteRequestedAt",
  );
  requireWithinWindow(verifiedAt, expected.notBeforeMs, expected.notAfterMs, "verifiedAt");
  if (verifiedAt <= deleteRequestedAt) {
    fail("BREV_CLEANUP_INCOMPLETE", "verifiedAt must follow deleteRequestedAt");
  }
  return cleanup;
}

export function parseBrevWorkspaceCleanupEvidenceJson(contents: string): unknown {
  return parseStrictEvidenceJson(contents, "cleanup evidence");
}

export function parseAndValidateBrevWorkspaceCleanupEvidence(
  contents: string,
  expected: BrevWorkspaceCleanupEvidenceExpectations,
): BrevWorkspaceCleanupEvidence {
  return validateBrevWorkspaceCleanupEvidence(
    parseBrevWorkspaceCleanupEvidenceJson(contents),
    expected,
  );
}

export function normalizedBrevWorkspaceCleanupEvidenceJson(
  evidence: BrevWorkspaceCleanupEvidence,
): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export function brevLaunchableWorkspaceFailureCode(
  error: unknown,
): BrevLaunchableWorkspaceFailureCode {
  return error instanceof BrevLaunchableWorkspaceError ? error.code : "UNKNOWN";
}
