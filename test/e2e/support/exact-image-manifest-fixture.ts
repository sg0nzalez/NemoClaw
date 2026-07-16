// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExactImageManifest,
  ExactImageManifestExpectations,
} from "../../../tools/e2e/exact-image-manifest.mts";

export const CANDIDATE_SHA = "a".repeat(40);
export const IMAGE_REPOSITORY_SHA = "b".repeat(40);
export const CORRELATION_ID = "12345678-1234-4123-8123-123456789abc";

export function exactImageManifest(
  overrides: Partial<ExactImageManifest> = {},
): ExactImageManifest {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-exact-image-manifest",
    correlationId: CORRELATION_ID,
    requesterRepository: "NVIDIA/NemoClaw",
    requesterWorkflowRunId: "8001",
    requesterWorkflowRunAttempt: 1,
    nemoclawSha: CANDIDATE_SHA,
    imageRepository: "brevdev/nemoclaw-image",
    imageRepositorySha: IMAGE_REPOSITORY_SHA,
    producerWorkflow: ".github/workflows/build-qualification-image.yml",
    workflowRunId: "9002",
    workflowRunAttempt: 1,
    imageOriginWorkflowRunId: "9002",
    imageOriginWorkflowRunAttempt: 1,
    imageKind: "compute#image",
    project: "brevdevprod",
    imageName: "nemoclaw-brev-cpu-v0-1-0-20260716-a-staging-190-1",
    imageId: "12345678901234567890",
    imageSelfLink:
      "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/nemoclaw-brev-cpu-v0-1-0-20260716-a-staging-190-1",
    status: "READY",
    imageCreationTimestamp: "2026-07-16T12:00:00.000Z",
    manifestCreatedAt: "2026-07-16T12:01:00.000Z",
    channel: "staging",
    variant: "cpu",
    observedFamily: "nemoclaw-brev-staging-cpu",
    result: "built",
    ...overrides,
  };
}

export function exactImageManifestExpectations(
  overrides: Partial<ExactImageManifestExpectations> = {},
): ExactImageManifestExpectations {
  return {
    correlationId: CORRELATION_ID,
    requesterWorkflowRunId: "8001",
    requesterWorkflowRunAttempt: 1,
    nemoclawSha: CANDIDATE_SHA,
    imageRepositorySha: IMAGE_REPOSITORY_SHA,
    workflowRunId: "9002",
    workflowRunAttempt: 1,
    ...overrides,
  };
}
