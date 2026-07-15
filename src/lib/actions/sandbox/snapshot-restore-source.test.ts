// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  commitWithStableSnapshotRestoreSource,
  type SnapshotRestoreSourceDescriptor,
} from "./snapshot-restore-source";

const source = {
  gatewayName: "gateway-a",
  id: "sandbox-id",
  name: "source",
  image: "registry/source@sha256:abc",
} satisfies SnapshotRestoreSourceDescriptor;

describe("commitWithStableSnapshotRestoreSource", () => {
  it("reads twice and commits only the second descriptor with preflight state", async () => {
    const events: string[] = [];
    const reads = [
      { ...source, readNumber: 1 },
      { ...source, readNumber: 2 },
    ];
    const readDescriptor = vi.fn(async () => {
      events.push("read");
      return reads[readDescriptor.mock.calls.length - 1];
    });
    const result = await commitWithStableSnapshotRestoreSource({
      gatewayName: source.gatewayName,
      sandboxName: source.name,
      readDescriptor,
      preMutationCheck: () => {
        events.push("preflight");
        return "checked";
      },
      commit: (descriptor, preflight) => {
        events.push("commit");
        expect((descriptor as (typeof reads)[number]).readNumber).toBe(2);
        expect(preflight).toBe("checked");
        return descriptor.image;
      },
    });

    expect(result).toBe(source.image);
    expect(events).toEqual(["read", "preflight", "read", "commit"]);
    expect(readDescriptor).toHaveBeenCalledTimes(2);
  });

  it("does not re-read or commit when read-only preflight fails", async () => {
    const readDescriptor = vi.fn(async () => source);
    const commit = vi.fn();
    await expect(
      commitWithStableSnapshotRestoreSource({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor,
        preMutationCheck: () => {
          throw new Error("unsafe destination");
        },
        commit,
      }),
    ).rejects.toThrow("unsafe destination");
    expect(readDescriptor).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["empty id", { ...source, id: "" }],
    ["padded image", { ...source, image: ` ${source.image}` }],
  ])("fails closed for an invalid %s", async (_label, invalid) => {
    const commit = vi.fn();
    await expect(
      commitWithStableSnapshotRestoreSource({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor: async () => invalid,
        preMutationCheck: vi.fn(),
        commit,
      }),
    ).rejects.toThrow(/Failed to read source sandbox before mutation/);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["name", { ...source, name: "other" }],
    ["gateway", { ...source, gatewayName: "gateway-b" }],
  ])("fails closed when the persisted %s does not match", async (_label, descriptor) => {
    const commit = vi.fn();
    await expect(
      commitWithStableSnapshotRestoreSource({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor: async () => descriptor,
        preMutationCheck: vi.fn(),
        commit,
      }),
    ).rejects.toThrow(/does not match the persisted source route/);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    "gatewayName",
    "id",
    "name",
    "image",
  ] as const)("fails closed when source %s drifts", async (key) => {
    const commit = vi.fn();
    const values = [source[key], `${source[key]}-changed`];
    const readDescriptor = vi.fn(async () => ({
      ...source,
      [key]: values[readDescriptor.mock.calls.length - 1],
    }));
    await expect(
      commitWithStableSnapshotRestoreSource({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor,
        preMutationCheck: vi.fn(),
        commit,
      }),
    ).rejects.toThrow(`Source sandbox ${key} changed`);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    [1, [() => Promise.reject(new Error("unavailable")), async () => source]],
    [2, [async () => source, () => Promise.reject(new Error("unavailable"))]],
  ] as const)("fails closed when descriptor read %i fails", async (failedRead, reads) => {
    const commit = vi.fn();
    const preMutationCheck = vi.fn();
    const readDescriptor = vi
      .fn()
      .mockImplementationOnce(reads[0])
      .mockImplementationOnce(reads[1]);
    await expect(
      commitWithStableSnapshotRestoreSource({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor,
        preMutationCheck,
        commit,
      }),
    ).rejects.toThrow(/Failed to read source sandbox .*mutation: unavailable/);
    expect(preMutationCheck).toHaveBeenCalledTimes(failedRead - 1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves mutation failures without relabeling them as descriptor failures", async () => {
    const failure = new Error("create failed");
    await expect(
      commitWithStableSnapshotRestoreSource({
        gatewayName: source.gatewayName,
        sandboxName: source.name,
        readDescriptor: async () => source,
        preMutationCheck: vi.fn(),
        commit: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});
