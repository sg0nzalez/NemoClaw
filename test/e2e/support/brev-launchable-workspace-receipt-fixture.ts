// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  BrevLaunchableWorkspaceReceipt,
  BrevLaunchableWorkspaceReceiptExpectations,
  BrevWorkspaceCleanupEvidence,
} from "../../../tools/e2e/brev-launchable-workspace-receipt.mts";
import { brevLaunchableWorkspaceReceiptSha256 } from "../../../tools/e2e/brev-launchable-workspace-receipt.mts";

export const BREV_RECEIPT_CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";
export const BREV_RECEIPT_CANDIDATE_SHA = "a".repeat(40);
export const BREV_RECEIPT_WINDOW_START = Date.parse("2026-07-16T12:00:00.000Z");
export const BREV_RECEIPT_WINDOW_END = Date.parse("2026-07-16T13:00:00.000Z");
export const BREV_CLEANUP_DEADLINE = Date.parse("2026-07-16T13:15:00.000Z");

export const BREV_IMAGE = {
  project: "brevdevprod",
  imageName: "nemoclaw-brev-cpu-v0-1-0-20260716-a-staging-190-1",
  imageId: "12345678901234567890",
  imageSelfLink:
    "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/nemoclaw-brev-cpu-v0-1-0-20260716-a-staging-190-1",
} as const;

export function brevLaunchableWorkspaceReceipt(
  overrides: Partial<BrevLaunchableWorkspaceReceipt> = {},
): BrevLaunchableWorkspaceReceipt {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-brev-launchable-workspace-receipt",
    correlationId: BREV_RECEIPT_CORRELATION_ID,
    nemoclawSha: BREV_RECEIPT_CANDIDATE_SHA,
    acceptedImageManifestSha256: "c".repeat(64),
    organizationId: "org-NemoClaw-staging",
    idempotencyKey: "qualification-run-1",
    launchable: {
      id: "env-3Azt0aYgVNFEuz7opyx3gscmowS",
      revision: "revision-01JZZZZZZZZZZZZZZZZZZZZZZZ",
      suppliedImageReference: BREV_IMAGE.imageSelfLink,
      resolvedImage: { ...BREV_IMAGE },
    },
    workspace: {
      id: "workspace-01JZZZZZZZZZZZZZZZZZZZZZZZ",
      launchableId: "env-3Azt0aYgVNFEuz7opyx3gscmowS",
      launchableRevision: "revision-01JZZZZZZZZZZZZZZZZZZZZZZZ",
      bootImage: { ...BREV_IMAGE },
      status: "READY",
    },
    recordedAt: "2026-07-16T12:45:00.000Z",
    ...overrides,
  };
}

export function brevLaunchableWorkspaceReceiptExpectations(
  overrides: Partial<BrevLaunchableWorkspaceReceiptExpectations> = {},
): BrevLaunchableWorkspaceReceiptExpectations {
  return {
    correlationId: BREV_RECEIPT_CORRELATION_ID,
    nemoclawSha: BREV_RECEIPT_CANDIDATE_SHA,
    acceptedImageManifestSha256: "c".repeat(64),
    organizationId: "org-NemoClaw-staging",
    idempotencyKey: "qualification-run-1",
    launchableId: "env-3Azt0aYgVNFEuz7opyx3gscmowS",
    launchableRevision: "revision-01JZZZZZZZZZZZZZZZZZZZZZZZ",
    workspaceId: "workspace-01JZZZZZZZZZZZZZZZZZZZZZZZ",
    suppliedImageReference: BREV_IMAGE.imageSelfLink,
    image: { ...BREV_IMAGE },
    notBeforeMs: BREV_RECEIPT_WINDOW_START,
    notAfterMs: BREV_RECEIPT_WINDOW_END,
    ...overrides,
  };
}

export function brevWorkspaceCleanupEvidence(
  receipt = brevLaunchableWorkspaceReceipt(),
  overrides: Partial<BrevWorkspaceCleanupEvidence> = {},
): BrevWorkspaceCleanupEvidence {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-brev-workspace-cleanup-evidence",
    correlationId: receipt.correlationId,
    receiptSha256: brevLaunchableWorkspaceReceiptSha256(receipt),
    organizationId: receipt.organizationId,
    workspaceId: receipt.workspace.id,
    launchableId: receipt.launchable.id,
    launchableRevision: receipt.launchable.revision,
    deleteRequestedAt: "2026-07-16T13:01:00.000Z",
    terminalState: "ABSENT",
    verifiedAt: "2026-07-16T13:04:00.000Z",
    ...overrides,
  };
}
