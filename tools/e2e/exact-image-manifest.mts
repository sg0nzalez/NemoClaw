// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const EXACT_IMAGE_MANIFEST_KIND = "nemoclaw-exact-image-manifest";
export const EXACT_IMAGE_REQUESTER_REPOSITORY = "NVIDIA/NemoClaw";
export const EXACT_IMAGE_REPOSITORY = "brevdev/nemoclaw-image";
export const EXACT_IMAGE_PRODUCER_WORKFLOW = ".github/workflows/build-qualification-image.yml";
// This mutable family is publication evidence only. Consumers accept the
// immutable name, numeric ID, and self-link below as the image identity.
export const EXACT_IMAGE_STAGING_FAMILY = "nemoclaw-brev-staging-cpu";
export const EXACT_IMAGE_MANIFEST_MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const EXACT_IMAGE_MANIFEST_MAX_REUSED_AGE_MS = 24 * 60 * 60_000;

export type ExactImageManifestFailureCode =
  | "REQUEST_INVALID"
  | "ARTIFACT_MISSING_OR_INVALID"
  | "UNSUPPORTED_VARIANT"
  | "PROVENANCE_MISMATCH"
  | "IMAGE_IDENTITY_MISMATCH"
  | "OUTPUT_WRITE_FAILED"
  | "UNKNOWN";

export class ExactImageManifestError extends Error {
  readonly code: ExactImageManifestFailureCode;

  constructor(code: ExactImageManifestFailureCode, message: string) {
    super(message);
    this.name = "ExactImageManifestError";
    this.code = code;
  }
}

export type ExactImageManifest = {
  schemaVersion: 1;
  kind: typeof EXACT_IMAGE_MANIFEST_KIND;
  correlationId: string;
  requesterRepository: typeof EXACT_IMAGE_REQUESTER_REPOSITORY;
  requesterWorkflowRunId: string;
  requesterWorkflowRunAttempt: number;
  nemoclawSha: string;
  imageRepository: typeof EXACT_IMAGE_REPOSITORY;
  imageRepositorySha: string;
  producerWorkflow: typeof EXACT_IMAGE_PRODUCER_WORKFLOW;
  workflowRunId: string;
  workflowRunAttempt: number;
  imageOriginWorkflowRunId: string;
  imageOriginWorkflowRunAttempt: number;
  imageKind: "compute#image";
  project: string;
  imageName: string;
  imageId: string;
  imageSelfLink: string;
  status: "READY";
  imageCreationTimestamp: string;
  manifestCreatedAt: string;
  channel: "staging";
  variant: "cpu";
  observedFamily: typeof EXACT_IMAGE_STAGING_FAMILY;
  result: "built" | "reused";
};

export type ExactImageManifestExpectations = {
  correlationId: string;
  requesterWorkflowRunId: string;
  requesterWorkflowRunAttempt: number;
  nemoclawSha: string;
  imageRepositorySha: string;
  workflowRunId: string;
  workflowRunAttempt: number;
};

const REQUIRED_FIELDS = [
  "schemaVersion",
  "kind",
  "correlationId",
  "requesterRepository",
  "requesterWorkflowRunId",
  "requesterWorkflowRunAttempt",
  "nemoclawSha",
  "imageRepository",
  "imageRepositorySha",
  "producerWorkflow",
  "workflowRunId",
  "workflowRunAttempt",
  "imageOriginWorkflowRunId",
  "imageOriginWorkflowRunAttempt",
  "imageKind",
  "project",
  "imageName",
  "imageId",
  "imageSelfLink",
  "status",
  "imageCreationTimestamp",
  "manifestCreatedAt",
  "channel",
  "variant",
  "observedFamily",
  "result",
] as const;

const REQUIRED_FIELD_SET = new Set<string>(REQUIRED_FIELDS);
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u;
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const IMAGE_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:[.](\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

function fail(code: ExactImageManifestFailureCode, message: string): never {
  throw new ExactImageManifestError(code, message);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ARTIFACT_MISSING_OR_INVALID", "manifest must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function validateExactFields(record: Record<string, unknown>): void {
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      fail("ARTIFACT_MISSING_OR_INVALID", `manifest is missing required field ${field}`);
    }
  }
  const unexpected = Object.keys(record)
    .filter((field) => !REQUIRED_FIELD_SET.has(field))
    .sort();
  if (unexpected.length > 0) {
    fail("ARTIFACT_MISSING_OR_INVALID", `manifest contains unexpected field ${unexpected[0]}`);
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be a string`);
  }
  return value;
}

function requirePositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be a positive safe integer`);
  }
  return value as number;
}

function requirePattern(value: string, field: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} has an invalid format`);
  }
}

function requireConstant<T extends string | number>(
  actual: unknown,
  expected: T,
  field: string,
): asserts actual is T {
  if (actual !== expected) {
    fail("PROVENANCE_MISMATCH", `${field} must equal ${JSON.stringify(expected)}`);
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseRfc3339(value: string, field: string): number {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be an RFC 3339 date-time`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be a real calendar date`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail("ARTIFACT_MISSING_OR_INVALID", `${field} must be an RFC 3339 date-time`);
  }
  return timestamp;
}

function validateExpectations(expected: ExactImageManifestExpectations): void {
  const stringPatterns: Array<[string, string, RegExp]> = [
    [expected.correlationId, "expected correlationId", UUID_V4_PATTERN],
    [expected.requesterWorkflowRunId, "expected requesterWorkflowRunId", DECIMAL_ID_PATTERN],
    [expected.nemoclawSha, "expected nemoclawSha", FULL_SHA_PATTERN],
    [expected.imageRepositorySha, "expected imageRepositorySha", FULL_SHA_PATTERN],
    [expected.workflowRunId, "expected workflowRunId", DECIMAL_ID_PATTERN],
  ];
  for (const [value, field, pattern] of stringPatterns) {
    if (typeof value !== "string" || !pattern.test(value)) {
      fail("REQUEST_INVALID", `${field} has an invalid format`);
    }
  }
  for (const [value, field] of [
    [expected.requesterWorkflowRunAttempt, "expected requesterWorkflowRunAttempt"],
    [expected.workflowRunAttempt, "expected workflowRunAttempt"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail("REQUEST_INVALID", `${field} must be a positive safe integer`);
    }
  }
}

function assertExpected(
  manifest: ExactImageManifest,
  expected: ExactImageManifestExpectations,
): void {
  const comparisons: Array<[unknown, unknown, string]> = [
    [manifest.correlationId, expected.correlationId, "correlationId"],
    [manifest.requesterWorkflowRunId, expected.requesterWorkflowRunId, "requesterWorkflowRunId"],
    [
      manifest.requesterWorkflowRunAttempt,
      expected.requesterWorkflowRunAttempt,
      "requesterWorkflowRunAttempt",
    ],
    [manifest.nemoclawSha, expected.nemoclawSha, "nemoclawSha"],
    [manifest.imageRepositorySha, expected.imageRepositorySha, "imageRepositorySha"],
    [manifest.workflowRunId, expected.workflowRunId, "workflowRunId"],
    [manifest.workflowRunAttempt, expected.workflowRunAttempt, "workflowRunAttempt"],
  ];
  for (const [actual, wanted, field] of comparisons) {
    if (actual !== wanted) {
      fail("PROVENANCE_MISMATCH", `${field} does not match the trusted request`);
    }
  }
}

function validateTemporalContract(manifest: ExactImageManifest): void {
  const imageCreated = parseRfc3339(manifest.imageCreationTimestamp, "imageCreationTimestamp");
  const manifestCreated = parseRfc3339(manifest.manifestCreatedAt, "manifestCreatedAt");
  if (imageCreated > manifestCreated + EXACT_IMAGE_MANIFEST_MAX_CLOCK_SKEW_MS) {
    fail(
      "PROVENANCE_MISMATCH",
      "imageCreationTimestamp is later than manifestCreatedAt beyond allowed clock skew",
    );
  }
  if (
    manifest.result === "reused" &&
    manifestCreated - imageCreated > EXACT_IMAGE_MANIFEST_MAX_REUSED_AGE_MS
  ) {
    fail("PROVENANCE_MISMATCH", "reused image is older than 24 hours");
  }
}

function buildManifest(record: Record<string, unknown>): ExactImageManifest {
  requireConstant(record.schemaVersion, 1, "schemaVersion");
  requireConstant(record.kind, EXACT_IMAGE_MANIFEST_KIND, "kind");
  requireConstant(
    record.requesterRepository,
    EXACT_IMAGE_REQUESTER_REPOSITORY,
    "requesterRepository",
  );
  requireConstant(record.imageRepository, EXACT_IMAGE_REPOSITORY, "imageRepository");
  requireConstant(record.producerWorkflow, EXACT_IMAGE_PRODUCER_WORKFLOW, "producerWorkflow");
  requireConstant(record.imageKind, "compute#image", "imageKind");
  requireConstant(record.status, "READY", "status");
  requireConstant(record.channel, "staging", "channel");

  const variant = requireString(record, "variant");
  if (variant !== "cpu") {
    fail("UNSUPPORTED_VARIANT", 'variant must equal "cpu"');
  }
  requireConstant(record.observedFamily, EXACT_IMAGE_STAGING_FAMILY, "observedFamily");

  const result = requireString(record, "result");
  if (result !== "built" && result !== "reused") {
    fail("ARTIFACT_MISSING_OR_INVALID", 'result must equal "built" or "reused"');
  }

  const manifest: ExactImageManifest = {
    schemaVersion: 1,
    kind: EXACT_IMAGE_MANIFEST_KIND,
    correlationId: requireString(record, "correlationId"),
    requesterRepository: EXACT_IMAGE_REQUESTER_REPOSITORY,
    requesterWorkflowRunId: requireString(record, "requesterWorkflowRunId"),
    requesterWorkflowRunAttempt: requirePositiveInteger(record, "requesterWorkflowRunAttempt"),
    nemoclawSha: requireString(record, "nemoclawSha"),
    imageRepository: EXACT_IMAGE_REPOSITORY,
    imageRepositorySha: requireString(record, "imageRepositorySha"),
    producerWorkflow: EXACT_IMAGE_PRODUCER_WORKFLOW,
    workflowRunId: requireString(record, "workflowRunId"),
    workflowRunAttempt: requirePositiveInteger(record, "workflowRunAttempt"),
    imageOriginWorkflowRunId: requireString(record, "imageOriginWorkflowRunId"),
    imageOriginWorkflowRunAttempt: requirePositiveInteger(record, "imageOriginWorkflowRunAttempt"),
    imageKind: "compute#image",
    project: requireString(record, "project"),
    imageName: requireString(record, "imageName"),
    imageId: requireString(record, "imageId"),
    imageSelfLink: requireString(record, "imageSelfLink"),
    status: "READY",
    imageCreationTimestamp: requireString(record, "imageCreationTimestamp"),
    manifestCreatedAt: requireString(record, "manifestCreatedAt"),
    channel: "staging",
    variant,
    observedFamily: EXACT_IMAGE_STAGING_FAMILY,
    result,
  };

  requirePattern(manifest.correlationId, "correlationId", UUID_V4_PATTERN);
  requirePattern(manifest.requesterWorkflowRunId, "requesterWorkflowRunId", DECIMAL_ID_PATTERN);
  requirePattern(manifest.nemoclawSha, "nemoclawSha", FULL_SHA_PATTERN);
  requirePattern(manifest.imageRepositorySha, "imageRepositorySha", FULL_SHA_PATTERN);
  requirePattern(manifest.workflowRunId, "workflowRunId", DECIMAL_ID_PATTERN);
  requirePattern(manifest.imageOriginWorkflowRunId, "imageOriginWorkflowRunId", DECIMAL_ID_PATTERN);
  if (!GCP_PROJECT_ID_PATTERN.test(manifest.project)) {
    fail("IMAGE_IDENTITY_MISMATCH", "project must be a canonical GCP project ID");
  }
  requirePattern(manifest.imageName, "imageName", IMAGE_NAME_PATTERN);
  requirePattern(manifest.imageId, "imageId", DECIMAL_ID_PATTERN);
  return manifest;
}

function validateImageSelfLink(manifest: ExactImageManifest): void {
  const expectedPath = `/compute/v1/projects/${manifest.project}/global/images/${manifest.imageName}`;
  const expectedSelfLink = `https://www.googleapis.com${expectedPath}`;
  let parsed: URL;
  try {
    parsed = new URL(manifest.imageSelfLink);
  } catch {
    fail("IMAGE_IDENTITY_MISMATCH", "imageSelfLink must be an absolute URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.googleapis.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== expectedPath ||
    manifest.imageSelfLink !== expectedSelfLink
  ) {
    fail("IMAGE_IDENTITY_MISMATCH", "imageSelfLink does not exactly identify project/imageName");
  }
}

export function parseExactImageManifestJson(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    fail("ARTIFACT_MISSING_OR_INVALID", "manifest is not valid JSON");
  }
}

export function validateExactImageManifest(
  value: unknown,
  expected: ExactImageManifestExpectations,
): ExactImageManifest {
  validateExpectations(expected);
  const record = requireRecord(value);
  validateExactFields(record);
  const manifest = buildManifest(record);

  validateImageSelfLink(manifest);
  if (
    manifest.result === "built" &&
    (manifest.imageOriginWorkflowRunId !== manifest.workflowRunId ||
      manifest.imageOriginWorkflowRunAttempt !== manifest.workflowRunAttempt)
  ) {
    fail(
      "PROVENANCE_MISMATCH",
      "built image origin run and attempt must match the current producer run",
    );
  }

  validateTemporalContract(manifest);
  assertExpected(manifest, expected);
  return manifest;
}

export function parseAndValidateExactImageManifest(
  contents: string,
  expected: ExactImageManifestExpectations,
): ExactImageManifest {
  return validateExactImageManifest(parseExactImageManifestJson(contents), expected);
}

export function normalizedExactImageManifestJson(manifest: ExactImageManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function exactImageManifestFailureCode(error: unknown): ExactImageManifestFailureCode {
  return error instanceof ExactImageManifestError ? error.code : "UNKNOWN";
}
