// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REBUILD_HERMES_OLD_BASE_FIXTURE = {
  imageRef:
    "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:fd77ff6024f6cc831b9020160e77a191a62daa84fd4da8f876e675c2705db05e",
  release: "v0.0.75",
  revision: "bd38b389af7aa68a767a88058bf849cc83d8486d",
  source: "https://github.com/NVIDIA/NemoClaw",
  hermesSemver: "0.17.0",
  hermesCalver: "2026.6.19",
} as const;

export interface RebuildHermesOldBaseFixtureEvidence {
  imageRef: string;
  release: string;
  revision: string;
  source: string;
  hermesVersion: string;
}

/**
 * Fail closed unless phase 2 pulled the exact reviewed historical image and
 * its published provenance still identifies the Hermes version under test.
 */
export function verifyRebuildHermesOldBaseFixture(
  imageRef: string,
  labelsJson: string,
  versionOutput: string,
): RebuildHermesOldBaseFixtureEvidence {
  const expected = REBUILD_HERMES_OLD_BASE_FIXTURE;
  if (imageRef !== expected.imageRef) {
    throw new Error("old Hermes fixture must use the reviewed immutable image digest");
  }

  let labels: Record<string, unknown>;
  try {
    const parsed = JSON.parse(labelsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    labels = parsed as Record<string, unknown>;
  } catch {
    throw new Error("old Hermes fixture OCI labels were not valid JSON");
  }

  const expectedLabels = {
    "org.opencontainers.image.version": expected.release,
    "org.opencontainers.image.revision": expected.revision,
    "org.opencontainers.image.source": expected.source,
  } as const;
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (labels[name] !== value) {
      throw new Error(`old Hermes fixture OCI label '${name}' did not match '${value}'`);
    }
  }

  const expectedVersion = `Hermes Agent v${expected.hermesSemver} (${expected.hermesCalver})`;
  if (!versionOutput.includes(expectedVersion)) {
    throw new Error(`old Hermes fixture runtime did not report '${expectedVersion}'`);
  }

  return {
    imageRef,
    release: expected.release,
    revision: expected.revision,
    source: expected.source,
    hermesVersion: expectedVersion,
  };
}
