// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  runSnapshotRestoreMutationAfterSourceRecheck,
  type SnapshotRestoreSourceDescriptor,
} from "./snapshot-restore-source";

const source = {
  gatewayName: "gateway-a",
  id: "sandbox-id",
  name: "source",
  image: "registry/source@sha256:abc",
} satisfies SnapshotRestoreSourceDescriptor;

describe("runSnapshotRestoreMutationAfterSourceRecheck", () => {
  it("samples twice and mutates only with the second descriptor and preflight state", async () => {
    const events: string[] = [];
    const reads = [
      { ...source, readNumber: 1 },
      { ...source, readNumber: 2 },
    ];
    const readDescriptor = vi.fn(async () => {
      events.push("read");
      return reads[readDescriptor.mock.calls.length - 1];
    });
    const result = await runSnapshotRestoreMutationAfterSourceRecheck({
      gatewayName: source.gatewayName,
      sandboxName: source.name,
      readDescriptor,
      preMutationCheck: () => {
        events.push("preflight");
        return "checked";
      },
      mutate: (descriptor, preflight) => {
        events.push("mutate");
        expect((descriptor as (typeof reads)[number]).readNumber).toBe(2);
        expect(preflight).toBe("checked");
        return descriptor.image;
      },
    });

    expect(result).toBe(source.image);
    expect(events).toEqual(["read", "preflight", "read", "mutate"]);
    expect(readDescriptor).toHaveBeenCalledTimes(2);
  });

  it("does not re-read or mutate when read-only preflight fails", async () => {
    const readDescriptor = vi.fn(async () => source);
    const mutate = vi.fn();
    await expect(
      runSnapshotRestoreMutationAfterSourceRecheck({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor,
        preMutationCheck: () => {
          throw new Error("unsafe destination");
        },
        mutate,
      }),
    ).rejects.toThrow("unsafe destination");
    expect(readDescriptor).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["empty id", { ...source, id: "" }],
    ["padded image", { ...source, image: ` ${source.image}` }],
  ])("fails closed for an invalid %s", async (_label, invalid) => {
    const mutate = vi.fn();
    await expect(
      runSnapshotRestoreMutationAfterSourceRecheck({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor: async () => invalid,
        preMutationCheck: vi.fn(),
        mutate,
      }),
    ).rejects.toThrow(/Failed to read source sandbox before mutation/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["name", { ...source, name: "other" }],
    ["gateway", { ...source, gatewayName: "gateway-b" }],
  ])("fails closed when the persisted %s does not match", async (_label, descriptor) => {
    const mutate = vi.fn();
    await expect(
      runSnapshotRestoreMutationAfterSourceRecheck({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor: async () => descriptor,
        preMutationCheck: vi.fn(),
        mutate,
      }),
    ).rejects.toThrow(/does not match the persisted source route/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    "gatewayName",
    "id",
    "name",
    "image",
  ] as const)("rejects source %s drift observed between samples", async (key) => {
    const mutate = vi.fn();
    const values = [source[key], `${source[key]}-changed`];
    const readDescriptor = vi.fn(async () => ({
      ...source,
      [key]: values[readDescriptor.mock.calls.length - 1],
    }));
    await expect(
      runSnapshotRestoreMutationAfterSourceRecheck({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor,
        preMutationCheck: vi.fn(),
        mutate,
      }),
    ).rejects.toThrow(`Source sandbox ${key} differed between pre-mutation descriptor samples`);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    [1, [() => Promise.reject(new Error("unavailable")), async () => source], "before mutation"],
    [2, [async () => source, () => Promise.reject(new Error("unavailable"))], "after preflight"],
  ] as const)("fails closed when descriptor read %i fails", async (failedRead, reads, phase) => {
    const mutate = vi.fn();
    const preMutationCheck = vi.fn();
    const readDescriptor = vi
      .fn()
      .mockImplementationOnce(reads[0])
      .mockImplementationOnce(reads[1]);
    await expect(
      runSnapshotRestoreMutationAfterSourceRecheck({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor,
        preMutationCheck,
        mutate,
      }),
    ).rejects.toThrow(`Failed to read source sandbox ${phase}: unavailable`);
    expect(preMutationCheck).toHaveBeenCalledTimes(failedRead - 1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("preserves mutation failures without relabeling them as descriptor failures", async () => {
    const failure = new Error("create failed");
    await expect(
      runSnapshotRestoreMutationAfterSourceRecheck({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor: async () => source,
        preMutationCheck: vi.fn(),
        mutate: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});
