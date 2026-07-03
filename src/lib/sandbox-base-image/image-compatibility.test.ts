// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock("../adapters/docker", () => ({
  dockerCapture: dockerMocks.capture,
}));

import {
  getImageGlibcVersion,
  imageMeetsMinimumGlibc,
  parseGlibcVersion,
  versionGte,
} from "./image-compatibility";

describe("sandbox base-image glibc compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["ldd (Debian GLIBC 2.41-12+deb13u2) 2.41", "2.41"],
    ["ldd (Ubuntu GLIBC 2.39-0ubuntu8.6) 2.39", "2.39"],
  ])("parses distribution ldd output %j (#4680)", (output, expected) => {
    expect(parseGlibcVersion(output)).toBe(expected);
  });

  it("parses the first non-empty line of multiline GNU libc output (#4680)", () => {
    expect(
      parseGlibcVersion("\n  ldd (GNU libc) 2.17\nCopyright (C) Free Software Foundation"),
    ).toBe("2.17");
  });

  it("returns null when ldd output has no glibc version (#4680)", () => {
    expect(parseGlibcVersion("ldd version unavailable")).toBeNull();
  });

  it("compares glibc versions numerically (#4680)", () => {
    expect(versionGte("2.41", "2.39")).toBe(true);
    expect(versionGte("2.39", "2.39")).toBe(true);
    expect(versionGte("2.36", "2.39")).toBe(false);
  });

  it("reads glibc through an isolated ldd container command (#4680)", () => {
    dockerMocks.capture.mockReturnValue("ldd (GNU libc) 2.41\nCopyright");

    expect(getImageGlibcVersion("sandbox-base:test")).toBe("2.41");
    expect(dockerMocks.capture).toHaveBeenCalledWith(
      ["run", "--rm", "--entrypoint", "/usr/bin/ldd", "sandbox-base:test", "--version"],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it("accepts an image that meets the minimum glibc version (#4680)", () => {
    dockerMocks.capture.mockReturnValue("ldd (GNU libc) 2.41\nCopyright");

    expect(imageMeetsMinimumGlibc("sandbox-base:test", "2.39")).toEqual({
      ok: true,
      version: "2.41",
    });
  });

  it("rejects an image below the minimum glibc version (#4680)", () => {
    dockerMocks.capture.mockReturnValue("ldd (GNU libc) 2.36\nCopyright");

    expect(imageMeetsMinimumGlibc("sandbox-base:test", "2.39")).toEqual({
      ok: false,
      version: "2.36",
    });
  });
});
