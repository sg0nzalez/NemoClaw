// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SnapshotRestoreSourceDescriptor {
  gatewayName: string;
  id: string;
  name: string;
  image: string;
}

export type SnapshotRestoreSourceReader = (
  sandboxName: string,
) => Promise<SnapshotRestoreSourceDescriptor>;

export class SnapshotRestoreSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotRestoreSourceError";
  }
}

interface SourceRecheckOptions<TPreflight, TResult> {
  gatewayName: string;
  sandboxName: string;
  readDescriptor: SnapshotRestoreSourceReader;
  preMutationCheck: () => Promise<TPreflight> | TPreflight;
  mutate: (
    descriptor: SnapshotRestoreSourceDescriptor,
    preflight: TPreflight,
  ) => Promise<TResult> | TResult;
}

function checkedDescriptor(
  descriptor: SnapshotRestoreSourceDescriptor,
): SnapshotRestoreSourceDescriptor {
  for (const key of ["gatewayName", "id", "name", "image"] as const) {
    const value = descriptor[key];
    if (!value || value.trim() !== value) {
      throw new Error(`OpenShell sandbox descriptor has an invalid ${key}.`);
    }
  }
  return { ...descriptor };
}

/**
 * Rechecks the source descriptor before handing control to the mutation callback.
 *
 * This is a best-effort sampled drift check, not an atomic source lock. It rejects
 * changes observed between the two reads, but an external OpenShell mutation can
 * still occur after the second read. Callers must not infer source stability across
 * the callback without a server-side revision or compare-and-create primitive.
 */
export async function runSnapshotRestoreMutationAfterSourceRecheck<TPreflight, TResult>(
  options: SourceRecheckOptions<TPreflight, TResult>,
): Promise<TResult> {
  const read = async (phase: string) => {
    try {
      return checkedDescriptor(await options.readDescriptor(options.sandboxName));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SnapshotRestoreSourceError(`Failed to read source sandbox ${phase}: ${detail}`, {
        cause: error,
      });
    }
  };
  const firstSample = await read("before mutation");
  if (firstSample.gatewayName !== options.gatewayName || firstSample.name !== options.sandboxName) {
    throw new SnapshotRestoreSourceError(
      "OpenShell sandbox descriptor does not match the persisted source route.",
    );
  }
  const preflight = await options.preMutationCheck();
  const secondSample = await read("after preflight");
  for (const key of ["gatewayName", "id", "name", "image"] as const) {
    if (secondSample[key] !== firstSample[key]) {
      throw new SnapshotRestoreSourceError(
        `Source sandbox ${key} differed between pre-mutation descriptor samples.`,
      );
    }
  }
  return options.mutate(secondSample, preflight);
}
