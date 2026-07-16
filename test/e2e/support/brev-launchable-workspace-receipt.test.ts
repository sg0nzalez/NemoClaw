// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BrevLaunchableWorkspaceError,
  brevLaunchableWorkspaceReceiptSha256,
  normalizedBrevLaunchableWorkspaceReceiptJson,
  normalizedBrevWorkspaceCleanupEvidenceJson,
  parseAndValidateBrevLaunchableWorkspaceReceipt,
  parseAndValidateBrevWorkspaceCleanupEvidence,
  validateBrevLaunchableWorkspaceReceipt,
  validateBrevWorkspaceCleanupEvidence,
} from "../../../tools/e2e/brev-launchable-workspace-receipt.mts";
import {
  BREV_CLEANUP_DEADLINE,
  BREV_IMAGE,
  BREV_RECEIPT_WINDOW_END,
  brevLaunchableWorkspaceReceipt,
  brevLaunchableWorkspaceReceiptExpectations,
  brevWorkspaceCleanupEvidence,
} from "./brev-launchable-workspace-receipt-fixture.ts";

function expectCode(run: () => unknown, code: BrevLaunchableWorkspaceError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BrevLaunchableWorkspaceError);
    expect((error as BrevLaunchableWorkspaceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("Brev Launchable and workspace evidence", () => {
  it("accepts only a ready workspace bound to one immutable Launchable revision and exact image", () => {
    const source = brevLaunchableWorkspaceReceipt();
    const accepted = validateBrevLaunchableWorkspaceReceipt(
      source,
      brevLaunchableWorkspaceReceiptExpectations(),
    );

    expect(accepted).toEqual(source);
    expect(accepted.workspace.launchableRevision).toBe(accepted.launchable.revision);
    expect(accepted.workspace.bootImage.imageId).toBe(BREV_IMAGE.imageId);
    expect(normalizedBrevLaunchableWorkspaceReceiptJson(accepted)).toBe(
      `${JSON.stringify(source, null, 2)}\n`,
    );
    expect(brevLaunchableWorkspaceReceiptSha256(accepted)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects missing and additional fields at every receipt layer", () => {
    const missing = { ...brevLaunchableWorkspaceReceipt() } as Record<string, unknown>;
    delete missing.acceptedImageManifestSha256;
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          missing,
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "ARTIFACT_MISSING_OR_INVALID",
    );

    const source = brevLaunchableWorkspaceReceipt();
    const additional = {
      ...source,
      launchable: { ...source.launchable, mutableFamilyWasCloseEnough: true },
    };
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          additional,
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "ARTIFACT_MISSING_OR_INVALID",
    );

    const extraImage = {
      ...source,
      workspace: {
        ...source.workspace,
        bootImage: { ...source.workspace.bootImage, imageFamily: "nemoclaw-brev-staging-cpu" },
      },
    };
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          extraImage,
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "ARTIFACT_MISSING_OR_INVALID",
    );

    for (const receipt of [
      {
        ...source,
        launchable: Object.fromEntries(
          Object.entries(source.launchable).filter(([field]) => field !== "revision"),
        ),
      },
      {
        ...source,
        workspace: Object.fromEntries(
          Object.entries(source.workspace).filter(([field]) => field !== "id"),
        ),
      },
      {
        ...source,
        launchable: {
          ...source.launchable,
          resolvedImage: Object.fromEntries(
            Object.entries(source.launchable.resolvedImage).filter(
              ([field]) => field !== "imageId",
            ),
          ),
        },
      },
      {
        ...source,
        workspace: {
          ...source.workspace,
          bootImage: Object.fromEntries(
            Object.entries(source.workspace.bootImage).filter(
              ([field]) => field !== "imageSelfLink",
            ),
          ),
        },
      },
    ]) {
      expectCode(
        () =>
          validateBrevLaunchableWorkspaceReceipt(
            receipt,
            brevLaunchableWorkspaceReceiptExpectations(),
          ),
        "ARTIFACT_MISSING_OR_INVALID",
      );
    }
  });

  it.each([
    ["correlation ID", { correlationId: "12345678-1234-1123-8123-123456789abc" }],
    ["candidate SHA", { nemoclawSha: "A".repeat(40) }],
    ["manifest hash", { acceptedImageManifestSha256: "b".repeat(63) }],
    ["organization control character", { organizationId: "org\nother" }],
  ])("rejects an invalid %s", (_name, overrides) => {
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          { ...brevLaunchableWorkspaceReceipt(), ...overrides },
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "ARTIFACT_MISSING_OR_INVALID",
    );
  });

  it("binds request, manifest, organization, idempotency, and supplied reference to trusted state", () => {
    const mismatches = [
      { correlationId: "87654321-4321-4321-8321-cba987654321" },
      { nemoclawSha: "d".repeat(40) },
      { acceptedImageManifestSha256: "f".repeat(64) },
      { organizationId: "org-other" },
      { idempotencyKey: "qualification-other" },
      { launchableId: "env-other" },
      { launchableRevision: "revision-other" },
      { workspaceId: "workspace-other" },
      {
        suppliedImageReference:
          "projects/brevdevprod/global/images/family/nemoclaw-brev-staging-cpu",
      },
    ];
    for (const expected of mismatches) {
      expectCode(
        () =>
          validateBrevLaunchableWorkspaceReceipt(
            brevLaunchableWorkspaceReceipt(),
            brevLaunchableWorkspaceReceiptExpectations(expected),
          ),
        "PROVENANCE_MISMATCH",
      );
    }
  });

  it("accepts only the immutable image or canonical staging family as the trusted supplied reference", () => {
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          brevLaunchableWorkspaceReceipt(),
          brevLaunchableWorkspaceReceiptExpectations({
            suppliedImageReference: "https://attacker.invalid/image",
          }),
        ),
      "REQUEST_INVALID",
    );

    const familyReference = "projects/brevdevprod/global/images/family/nemoclaw-brev-staging-cpu";
    const familyReceipt = brevLaunchableWorkspaceReceipt({
      launchable: {
        ...brevLaunchableWorkspaceReceipt().launchable,
        suppliedImageReference: familyReference,
      },
    });
    expect(
      validateBrevLaunchableWorkspaceReceipt(
        familyReceipt,
        brevLaunchableWorkspaceReceiptExpectations({ suppliedImageReference: familyReference }),
      ),
    ).toEqual(familyReceipt);
  });

  it("requires structured workspace readiness", () => {
    const source = brevLaunchableWorkspaceReceipt();
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          { ...source, workspace: { ...source.workspace, status: "RUNNING" } },
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "BREV_READINESS_FAILED",
    );
  });

  it("binds opaque Brev IDs and revision to durable observations and workspace readback", () => {
    const source = brevLaunchableWorkspaceReceipt();
    for (const receipt of [
      {
        ...source,
        workspace: { ...source.workspace, launchableRevision: "revision-other" },
      },
      { ...source, workspace: { ...source.workspace, launchableId: "env-other" } },
    ]) {
      expectCode(
        () =>
          validateBrevLaunchableWorkspaceReceipt(
            receipt,
            brevLaunchableWorkspaceReceiptExpectations(),
          ),
        "PROVENANCE_MISMATCH",
      );
    }
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          { ...source, launchable: { ...source.launchable, revision: "current" } },
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "PROVENANCE_MISMATCH",
    );
  });

  it("rejects family-only, name-only, same-name replacement, and different boot-image evidence", () => {
    const source = brevLaunchableWorkspaceReceipt();
    const mismatches = [
      {
        ...source,
        launchable: {
          ...source.launchable,
          resolvedImage: {
            ...source.launchable.resolvedImage,
            imageSelfLink:
              "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/family/nemoclaw-brev-staging-cpu",
          },
        },
      },
      {
        ...source,
        workspace: {
          ...source.workspace,
          bootImage: { ...source.workspace.bootImage, imageId: "99999999999999999999" },
        },
      },
      {
        ...source,
        workspace: {
          ...source.workspace,
          bootImage: { ...source.workspace.bootImage, imageName: "different-image" },
        },
      },
    ];
    for (const receipt of mismatches) {
      expectCode(
        () =>
          validateBrevLaunchableWorkspaceReceipt(
            receipt,
            brevLaunchableWorkspaceReceiptExpectations(),
          ),
        "BREV_IMAGE_RESOLUTION_MISMATCH",
      );
    }
  });

  it("requires one real canonical UTC receipt time inside the trusted window", () => {
    for (const recordedAt of [
      "2026-02-30T12:00:00.000Z",
      "2026-07-16T12:45:00Z",
      "2026-07-16T12:45:00.000+00:00",
      "2026-07-16T13:00:00.001Z",
    ]) {
      expectCode(
        () =>
          validateBrevLaunchableWorkspaceReceipt(
            brevLaunchableWorkspaceReceipt({ recordedAt }),
            brevLaunchableWorkspaceReceiptExpectations(),
          ),
        recordedAt === "2026-07-16T13:00:00.001Z"
          ? "PROVENANCE_MISMATCH"
          : "ARTIFACT_MISSING_OR_INVALID",
      );
    }
    expect(
      validateBrevLaunchableWorkspaceReceipt(
        brevLaunchableWorkspaceReceipt({
          recordedAt: new Date(BREV_RECEIPT_WINDOW_END).toISOString(),
        }),
        brevLaunchableWorkspaceReceiptExpectations(),
      ).recordedAt,
    ).toBe("2026-07-16T13:00:00.000Z");
  });

  it("parses bounded strict JSON and rejects malformed, duplicate, deep, and trailing data", () => {
    const source = brevLaunchableWorkspaceReceipt();
    expect(
      parseAndValidateBrevLaunchableWorkspaceReceipt(
        JSON.stringify(source),
        brevLaunchableWorkspaceReceiptExpectations(),
      ),
    ).toEqual(source);
    for (const contents of [
      "{not-json",
      '{"a":1,"\\u0061":2}',
      "[[[[[[[0]]]]]]]",
      `${JSON.stringify(source)}\ntransport output`,
      " ".repeat(64 * 1024 + 1),
    ]) {
      expectCode(
        () =>
          parseAndValidateBrevLaunchableWorkspaceReceipt(
            contents,
            brevLaunchableWorkspaceReceiptExpectations(),
          ),
        "ARTIFACT_MISSING_OR_INVALID",
      );
    }
  });

  it("accepts terminal absence only when cleanup is bound to the immutable receipt and IDs", () => {
    const receipt = brevLaunchableWorkspaceReceipt();
    const cleanup = brevWorkspaceCleanupEvidence(receipt);
    const accepted = validateBrevWorkspaceCleanupEvidence(cleanup, {
      correlationId: receipt.correlationId,
      receiptSha256: brevLaunchableWorkspaceReceiptSha256(receipt),
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspace.id,
      launchableId: receipt.launchable.id,
      launchableRevision: receipt.launchable.revision,
      notBeforeMs: Date.parse(receipt.recordedAt),
      notAfterMs: BREV_CLEANUP_DEADLINE,
    });

    expect(accepted).toEqual(cleanup);
    expect(normalizedBrevWorkspaceCleanupEvidenceJson(accepted)).toBe(
      `${JSON.stringify(cleanup, null, 2)}\n`,
    );
    expect(
      parseAndValidateBrevWorkspaceCleanupEvidence(JSON.stringify(cleanup), {
        correlationId: receipt.correlationId,
        receiptSha256: brevLaunchableWorkspaceReceiptSha256(receipt),
        organizationId: receipt.organizationId,
        workspaceId: receipt.workspace.id,
        launchableId: receipt.launchable.id,
        launchableRevision: receipt.launchable.revision,
        notBeforeMs: Date.parse(receipt.recordedAt),
        notAfterMs: BREV_CLEANUP_DEADLINE,
      }),
    ).toEqual(cleanup);
  });

  it("rejects delete acknowledgement, deletion in progress, false absence, and unbound cleanup", () => {
    const receipt = brevLaunchableWorkspaceReceipt();
    const expected = {
      correlationId: receipt.correlationId,
      receiptSha256: brevLaunchableWorkspaceReceiptSha256(receipt),
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspace.id,
      launchableId: receipt.launchable.id,
      launchableRevision: receipt.launchable.revision,
      notBeforeMs: Date.parse(receipt.recordedAt),
      notAfterMs: BREV_CLEANUP_DEADLINE,
    };

    for (const cleanup of [
      { ...brevWorkspaceCleanupEvidence(receipt), terminalState: "DELETE_ACCEPTED" },
      { ...brevWorkspaceCleanupEvidence(receipt), terminalState: "DELETING" },
    ]) {
      expectCode(
        () => validateBrevWorkspaceCleanupEvidence(cleanup, expected),
        "BREV_CLEANUP_INCOMPLETE",
      );
    }
    for (const cleanup of [
      brevWorkspaceCleanupEvidence(receipt, { receiptSha256: "f".repeat(64) }),
      brevWorkspaceCleanupEvidence(receipt, { workspaceId: "workspace-other" }),
      brevWorkspaceCleanupEvidence(receipt, { launchableRevision: "revision-other" }),
    ]) {
      expectCode(
        () => validateBrevWorkspaceCleanupEvidence(cleanup, expected),
        "PROVENANCE_MISMATCH",
      );
    }

    const missing = { ...brevWorkspaceCleanupEvidence(receipt) } as Record<string, unknown>;
    delete missing.receiptSha256;
    for (const cleanup of [
      missing,
      { ...brevWorkspaceCleanupEvidence(receipt), diagnostic: "ok" },
    ]) {
      expectCode(
        () => validateBrevWorkspaceCleanupEvidence(cleanup, expected),
        "ARTIFACT_MISSING_OR_INVALID",
      );
    }
  });

  it("requires ordered cleanup timestamps inside the controller deadline", () => {
    const receipt = brevLaunchableWorkspaceReceipt();
    const expected = {
      correlationId: receipt.correlationId,
      receiptSha256: brevLaunchableWorkspaceReceiptSha256(receipt),
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspace.id,
      launchableId: receipt.launchable.id,
      launchableRevision: receipt.launchable.revision,
      notBeforeMs: Date.parse(receipt.recordedAt),
      notAfterMs: BREV_CLEANUP_DEADLINE,
    };
    for (const cleanup of [
      brevWorkspaceCleanupEvidence(receipt, {
        deleteRequestedAt: "2026-07-16T13:05:00.000Z",
        verifiedAt: "2026-07-16T13:04:00.000Z",
      }),
      brevWorkspaceCleanupEvidence(receipt, { verifiedAt: "2026-07-16T13:15:00.001Z" }),
    ]) {
      expectCode(
        () => validateBrevWorkspaceCleanupEvidence(cleanup, expected),
        cleanup.verifiedAt.endsWith("001Z") ? "PROVENANCE_MISMATCH" : "BREV_CLEANUP_INCOMPLETE",
      );
    }
    expectCode(
      () =>
        validateBrevWorkspaceCleanupEvidence(
          brevWorkspaceCleanupEvidence(receipt, {
            deleteRequestedAt: "2026-07-16T13:04:00.000Z",
            verifiedAt: "2026-07-16T13:04:00.000Z",
          }),
          expected,
        ),
      "BREV_CLEANUP_INCOMPLETE",
    );
    expectCode(
      () =>
        validateBrevWorkspaceCleanupEvidence(
          brevWorkspaceCleanupEvidence(receipt, {
            deleteRequestedAt: "2026-07-16T12:44:59.999Z",
          }),
          expected,
        ),
      "PROVENANCE_MISMATCH",
    );
  });

  it("requires separately anchored cleanup and rejects consistent receipt plus cleanup tampering", () => {
    const receipt = brevLaunchableWorkspaceReceipt();
    const cleanupExpected = {
      correlationId: receipt.correlationId,
      receiptSha256: brevLaunchableWorkspaceReceiptSha256(receipt),
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspace.id,
      launchableId: receipt.launchable.id,
      launchableRevision: receipt.launchable.revision,
      notBeforeMs: Date.parse(receipt.recordedAt),
      notAfterMs: BREV_CLEANUP_DEADLINE,
    };
    expectCode(
      () => validateBrevWorkspaceCleanupEvidence(undefined, cleanupExpected),
      "ARTIFACT_MISSING_OR_INVALID",
    );

    const forged = brevLaunchableWorkspaceReceipt({
      launchable: {
        ...receipt.launchable,
        id: "env-forged",
        revision: "revision-forged",
      },
      workspace: {
        ...receipt.workspace,
        id: "workspace-forged",
        launchableId: "env-forged",
        launchableRevision: "revision-forged",
      },
    });
    expectCode(
      () =>
        validateBrevLaunchableWorkspaceReceipt(
          forged,
          brevLaunchableWorkspaceReceiptExpectations(),
        ),
      "PROVENANCE_MISMATCH",
    );
    expectCode(
      () =>
        validateBrevWorkspaceCleanupEvidence(brevWorkspaceCleanupEvidence(forged), cleanupExpected),
      "PROVENANCE_MISMATCH",
    );
  });
});
