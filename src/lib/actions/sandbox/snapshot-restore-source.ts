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

interface StableSourceOptions<TPreflight, TResult> {
  gatewayName: string;
  sandboxName: string;
  readDescriptor: SnapshotRestoreSourceReader;
  preMutationCheck: () => Promise<TPreflight> | TPreflight;
  commit: (
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

export async function commitWithStableSnapshotRestoreSource<TPreflight, TResult>(
  options: StableSourceOptions<TPreflight, TResult>,
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
  const pinned = await read("before mutation");
  if (pinned.gatewayName !== options.gatewayName || pinned.name !== options.sandboxName) {
    throw new SnapshotRestoreSourceError(
      "OpenShell sandbox descriptor does not match the persisted source route.",
    );
  }
  const preflight = await options.preMutationCheck();
  const current = await read("immediately before mutation");
  for (const key of ["gatewayName", "id", "name", "image"] as const) {
    if (current[key] !== pinned[key]) {
      throw new SnapshotRestoreSourceError(
        `Source sandbox ${key} changed before snapshot restore mutation.`,
      );
    }
  }
  return options.commit(current, preflight);
}
