// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REBUILD_HERMES_OLD_BASE_FIXTURE = {
  imageRef:
    "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:48c758b7f69982740a7aa52e666c11d7f1be1faaf74550cab52b657fbfa238be",
  release: "v0.0.50",
  revision: "14b2be2933ca8e001f66575a1e7bb4f166f401d8",
  source: "https://github.com/NVIDIA/NemoClaw",
  hermesSemver: "0.14.0",
  hermesCalver: "2026.5.16",
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
