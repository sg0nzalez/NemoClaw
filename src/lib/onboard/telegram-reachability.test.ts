// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProbeResult } from "./types";

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(),
}));

import { runCurlProbe } from "../adapters/http/probe";
import {
  checkTelegramReachability,
  TELEGRAM_NETWORK_CURL_CODES,
  type TelegramReachabilityDeps,
} from "./telegram-reachability";

function probeOk(): ProbeResult {
  return { ok: true, httpStatus: 200, curlStatus: 0, body: '{"ok":true}', stderr: "", message: "" };
}

function probeHttpError(httpStatus: number): ProbeResult {
  return { ok: false, httpStatus, curlStatus: 0, body: "", stderr: "", message: "" };
}

function probeCurlError(curlStatus: number): ProbeResult {
  return { ok: false, httpStatus: 0, curlStatus, body: "", stderr: "", message: "curl failed" };
}

function makeDeps(overrides: Partial<TelegramReachabilityDeps> = {}): TelegramReachabilityDeps {
  return {
    isNonInteractive: vi.fn(() => true),
    note: vi.fn(),
    promptYesNoOrDefault: vi.fn(async () => true),
    exit: vi.fn((code?: number): never => {
      throw new Error(`process.exit(${code ?? 0})`);
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(runCurlProbe).mockReset();
  delete process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY;
  vi.restoreAllMocks();
});

describe("checkTelegramReachability", () => {
  it("accepts HTTP 200 as reachable and valid", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeOk());

    await expect(checkTelegramReachability("123:abc", makeDeps())).resolves.toBeUndefined();

    expect(runCurlProbe).toHaveBeenCalledWith([
      "-sS",
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "https://api.telegram.org/bot123:abc/getMe",
    ]);
  });

  it("warns but keeps Telegram enabled when Telegram rejects the token", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeHttpError(401));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps();

    await expect(checkTelegramReachability("123:abc", deps)).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(
      "  ⚠ Bot token was rejected by Telegram — verify the token is correct.",
    );
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("aborts non-interactive onboarding for each Telegram network curl failure", async () => {
    for (const code of TELEGRAM_NETWORK_CURL_CODES) {
      vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(code));
      const deps = makeDeps();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(checkTelegramReachability("123:abc", deps)).rejects.toThrow("process.exit(1)");
      expect(deps.exit).toHaveBeenCalledWith(1);
    }
  });

  it("continues after an interactive user accepts the network-failure warning", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(7));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps({
      isNonInteractive: vi.fn(() => false),
      promptYesNoOrDefault: vi.fn(async () => true),
    });

    await expect(checkTelegramReachability("123:abc", deps)).resolves.toBeUndefined();

    expect(deps.promptYesNoOrDefault).toHaveBeenCalledWith("    Continue anyway?", null, false);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("aborts after an interactive user declines the network-failure warning", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeCurlError(7));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps({
      isNonInteractive: vi.fn(() => false),
      promptYesNoOrDefault: vi.fn(async () => false),
    });

    await expect(checkTelegramReachability("123:abc", deps)).rejects.toThrow("process.exit(1)");

    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("skips the probe when NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1", async () => {
    process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
    const deps = makeDeps();

    await expect(checkTelegramReachability("123:abc", deps)).resolves.toBeUndefined();

    expect(runCurlProbe).not.toHaveBeenCalled();
    expect(deps.note).toHaveBeenCalledWith(
      "  [non-interactive] Skipping Telegram reachability probe by request.",
    );
  });

  it("warns but does not block on unexpected HTTP errors", async () => {
    vi.mocked(runCurlProbe).mockReturnValue(probeHttpError(500));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = makeDeps();

    await expect(checkTelegramReachability("123:abc", deps)).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(
      "  ⚠ Telegram API returned HTTP 500 — the bot may not work correctly.",
    );
    expect(deps.exit).not.toHaveBeenCalled();
  });
});
