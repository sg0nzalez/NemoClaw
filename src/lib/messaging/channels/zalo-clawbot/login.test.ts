// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { normalizeClawbotAccountId, runZaloClawbotHostQrLogin } from "./login";
import { type FetchLike, requestZaloClawbotLogin } from "./qr";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Build a fetch fake that returns request-login once and walks a scripted
 *  list of get-login-status responses on each poll. */
function pollResponse(next: unknown) {
  const override =
    next && typeof next === "object" && "__status" in next
      ? (next as { __status: number }).__status
      : null;
  return override === null ? jsonResponse(200, next) : jsonResponse(override, {});
}

function fakeFetch(statuses: unknown[], loginBodies?: unknown[]): FetchLike {
  let loginCalls = 0;
  let pollCalls = 0;
  return async (url: string) => {
    const isLogin = url.includes("/agent/request-login");
    const loginBody = loginBodies?.[loginCalls] ?? {
      result: { loginUrl: "https://zalo.me/s/abc", zbsk: "zbsk-1" },
    };
    const poll = pollResponse(statuses[Math.min(pollCalls, statuses.length - 1)]);
    loginCalls += isLogin ? 1 : 0;
    pollCalls += isLogin ? 0 : 1;
    return isLogin ? jsonResponse(200, loginBody) : poll;
  };
}

const silent = { renderQr: () => {}, log: () => {}, sleep: async () => {}, now: () => 1_000 };

describe("Zalo ClawBot host QR login", () => {
  it("derives the account id from the bot id (normalizing @ and .)", () => {
    expect(normalizeClawbotAccountId("clawbot-a.b@c")).toBe("clawbot-a-b-c");
  });

  it("returns credentials once the server confirms the login", async () => {
    const result = await runZaloClawbotHostQrLogin({
      ...silent,
      fetch: fakeFetch([
        { result: { isLogin: false } },
        {
          result: {
            isLogin: true,
            botToken: "123:secret",
            botId: "123",
            ownerId: "owner-1",
            oaId: "oa-1",
          },
        },
      ]),
    });
    expect(result).toEqual({
      kind: "ok",
      credentials: {
        token: "123:secret",
        accountId: "clawbot-123",
        botId: "123",
        ownerId: "owner-1",
        oaId: "oa-1",
      },
    });
  });

  it("completes when the confirmation omits botId by deriving it from the token", async () => {
    // Regression: the live get-login-status confirmation can return isLogin +
    // botToken without an explicit botId. The loop must still finish (it hung
    // before, leaving the QR on screen forever) by using the token's id prefix.
    const result = await runZaloClawbotHostQrLogin({
      ...silent,
      fetch: fakeFetch([
        { result: { isLogin: false } },
        { result: { isLogin: true, botToken: "456:secret" } },
      ]),
    });
    expect(result).toEqual({
      kind: "ok",
      credentials: { token: "456:secret", accountId: "clawbot-456", botId: "456" },
    });
  });

  it("refreshes the QR on expiry and then completes", async () => {
    const result = await runZaloClawbotHostQrLogin({
      ...silent,
      fetch: fakeFetch([
        { __status: 498 },
        { result: { isLogin: true, botToken: "9:tok", botId: "9" } },
      ]),
    });
    expect(result).toMatchObject({
      kind: "ok",
      credentials: { token: "9:tok", accountId: "clawbot-9", botId: "9" },
    });
  });

  it("reports an error when request-login is malformed", async () => {
    const result = await runZaloClawbotHostQrLogin({
      ...silent,
      fetch: fakeFetch([{ result: { isLogin: false } }], [{ result: {} }]),
    });
    expect(result).toMatchObject({ kind: "error" });
  });

  it("fails fast on an unexpected 4xx from get-login-status", async () => {
    const result = await runZaloClawbotHostQrLogin({
      ...silent,
      fetch: fakeFetch([{ __status: 401 }]),
    });
    expect(result).toMatchObject({ kind: "error" });
  });

  it("forwards the abort signal to the underlying request", async () => {
    const controller = new AbortController();
    controller.abort();
    let sawAbortedSignal = false;
    const fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
      sawAbortedSignal = init?.signal?.aborted === true;
      return Promise.reject(new Error("aborted"));
    }) as unknown as FetchLike;
    await expect(requestZaloClawbotLogin({ fetch, signal: controller.signal })).rejects.toThrow();
    expect(sawAbortedSignal).toBe(true);
  });
});
