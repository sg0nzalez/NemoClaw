// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EXACT_IMAGE_MANIFEST_MAX_CLOCK_SKEW_MS,
  ExactImageManifestError,
  normalizedExactImageManifestJson,
  parseAndValidateExactImageManifest,
  validateExactImageManifest,
} from "../../../tools/e2e/exact-image-manifest.mts";
import {
  CANDIDATE_SHA,
  CORRELATION_ID,
  exactImageManifest,
  exactImageManifestExpectations,
  IMAGE_REPOSITORY_SHA,
} from "./exact-image-manifest-fixture.ts";

function expectCode(run: () => unknown, code: ExactImageManifestError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExactImageManifestError);
    expect((error as ExactImageManifestError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("exact staging image manifest consumer", () => {
  it("accepts and normalizes one exact built CPU image", () => {
    const source = exactImageManifest();
    const accepted = validateExactImageManifest(source, exactImageManifestExpectations());

    expect(accepted).toEqual(source);
    expect(accepted.imageId).toBe("12345678901234567890");
    expect(normalizedExactImageManifestJson(accepted)).toBe(`${JSON.stringify(source, null, 2)}\n`);
  });

  it("accepts a reused image with required origin evidence at the 24-hour boundary", () => {
    const reused = exactImageManifest({
      result: "reused",
      imageOriginWorkflowRunId: "7000",
      imageOriginWorkflowRunAttempt: 3,
      imageCreationTimestamp: "2026-07-15T12:01:00.000Z",
    });

    expect(validateExactImageManifest(reused, exactImageManifestExpectations())).toEqual(reused);
  });

  it("requires reused manifests to carry both origin fields", () => {
    for (const field of ["imageOriginWorkflowRunId", "imageOriginWorkflowRunAttempt"] as const) {
      const reused = { ...exactImageManifest({ result: "reused" }) } as Record<string, unknown>;
      delete reused[field];
      expectCode(
        () => validateExactImageManifest(reused, exactImageManifestExpectations()),
        "ARTIFACT_MISSING_OR_INVALID",
      );
    }
  });

  it("rejects missing and additional fields", () => {
    const missing = { ...exactImageManifest() } as Record<string, unknown>;
    delete missing.imageId;
    expectCode(
      () => validateExactImageManifest(missing, exactImageManifestExpectations()),
      "ARTIFACT_MISSING_OR_INVALID",
    );

    const additional = { ...exactImageManifest(), mutableImageFamilyFallback: true };
    expectCode(
      () => validateExactImageManifest(additional, exactImageManifestExpectations()),
      "ARTIFACT_MISSING_OR_INVALID",
    );
  });

  it.each([
    ["uppercase candidate SHA", { nemoclawSha: CANDIDATE_SHA.toUpperCase() }],
    ["short image repository SHA", { imageRepositorySha: IMAGE_REPOSITORY_SHA.slice(0, 12) }],
    ["uppercase correlation UUID", { correlationId: CORRELATION_ID.toUpperCase() }],
    ["zero requester run ID", { requesterWorkflowRunId: "0" }],
    ["numeric image ID", { imageId: 123456789 }],
    ["zero image ID", { imageId: "0" }],
    ["fractional workflow attempt", { workflowRunAttempt: 1.5 }],
  ])("rejects an invalid %s", (_name, overrides) => {
    expectCode(
      () =>
        validateExactImageManifest(
          { ...exactImageManifest(), ...overrides },
          exactImageManifestExpectations(),
        ),
      "ARTIFACT_MISSING_OR_INVALID",
    );
  });

  it.each([
    ["requester repository", { requesterRepository: "somewhere/NemoClaw" }],
    ["image repository", { imageRepository: "brevdev/other-image" }],
    ["producer workflow", { producerWorkflow: ".github/workflows/build-image.yml" }],
    ["image kind", { imageKind: "compute#family" }],
    ["status", { status: "PENDING" }],
    ["channel", { channel: "production" }],
    ["observed family", { observedFamily: "nemoclaw-brev-production-cpu" }],
  ])("rejects the wrong fixed %s", (_name, overrides) => {
    expectCode(
      () =>
        validateExactImageManifest(
          { ...exactImageManifest(), ...overrides },
          exactImageManifestExpectations(),
        ),
      "PROVENANCE_MISMATCH",
    );
  });

  it("rejects GPU before any later dispatch can consume it", () => {
    expectCode(
      () =>
        validateExactImageManifest(
          {
            ...exactImageManifest(),
            variant: "gpu",
            observedFamily: "nemoclaw-brev-staging-gpu",
          },
          exactImageManifestExpectations(),
        ),
      "UNSUPPORTED_VARIANT",
    );
  });

  it("requires an immutable self-link reconstructed from project and image name", () => {
    for (const imageSelfLink of [
      "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/family/nemoclaw-brev-staging-cpu",
      "https://www.googleapis.com/compute/v1/projects/other/global/images/nemoclaw-brev-cpu-v0-1-0-20260716-a-staging-190-1",
    ]) {
      expectCode(
        () =>
          validateExactImageManifest(
            exactImageManifest({ imageSelfLink }),
            exactImageManifestExpectations(),
          ),
        "IMAGE_IDENTITY_MISMATCH",
      );
    }
  });

  it("binds the manifest to the trusted request and producer run", () => {
    const expectationMismatches = [
      { nemoclawSha: "c".repeat(40) },
      { requesterWorkflowRunId: "8002" },
      { requesterWorkflowRunAttempt: 2 },
      { correlationId: "87654321-4321-4321-8321-cba987654321" },
      { imageRepositorySha: "d".repeat(40) },
      { workflowRunId: "9003" },
      { workflowRunAttempt: 2 },
    ];
    for (const expected of expectationMismatches) {
      expectCode(
        () =>
          validateExactImageManifest(
            exactImageManifest(),
            exactImageManifestExpectations(expected),
          ),
        "PROVENANCE_MISMATCH",
      );
    }
  });

  it("requires built images to originate in the current run", () => {
    expectCode(
      () =>
        validateExactImageManifest(
          exactImageManifest({ imageOriginWorkflowRunId: "7000" }),
          exactImageManifestExpectations(),
        ),
      "PROVENANCE_MISMATCH",
    );
  });

  it("enforces real timestamps, bounded clock skew, and the reused-image age", () => {
    expectCode(
      () =>
        validateExactImageManifest(
          exactImageManifest({ imageCreationTimestamp: "2026-02-30T12:00:00Z" }),
          exactImageManifestExpectations(),
        ),
      "ARTIFACT_MISSING_OR_INVALID",
    );

    const beyondSkew = new Date(
      Date.parse("2026-07-16T12:01:00.000Z") + EXACT_IMAGE_MANIFEST_MAX_CLOCK_SKEW_MS + 1,
    ).toISOString();
    const atSkew = new Date(
      Date.parse("2026-07-16T12:01:00.000Z") + EXACT_IMAGE_MANIFEST_MAX_CLOCK_SKEW_MS,
    ).toISOString();
    expect(
      validateExactImageManifest(
        exactImageManifest({ imageCreationTimestamp: atSkew }),
        exactImageManifestExpectations(),
      ).imageCreationTimestamp,
    ).toBe(atSkew);
    expectCode(
      () =>
        validateExactImageManifest(
          exactImageManifest({ imageCreationTimestamp: beyondSkew }),
          exactImageManifestExpectations(),
        ),
      "PROVENANCE_MISMATCH",
    );

    expectCode(
      () =>
        validateExactImageManifest(
          exactImageManifest({
            result: "reused",
            imageOriginWorkflowRunId: "7000",
            imageCreationTimestamp: "2026-07-15T12:00:59.999Z",
          }),
          exactImageManifestExpectations(),
        ),
      "PROVENANCE_MISMATCH",
    );
  });

  it("rejects invalid JSON before semantic validation", () => {
    expectCode(
      () => parseAndValidateExactImageManifest("{not-json", exactImageManifestExpectations()),
      "ARTIFACT_MISSING_OR_INVALID",
    );
  });
});
