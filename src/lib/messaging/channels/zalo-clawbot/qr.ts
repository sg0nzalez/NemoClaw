// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side QR login client for Zalo ClawBot (personal, owner-bound).
//
// NemoClaw-native re-implementation of the QR handshake the upstream
// @zalo-platforms/openclaw-zaloclawbot plugin runs in-sandbox
// (https://docs.openclaw.ai/channels/zaloclawbot). Running it on the host
// during onboarding lets NemoClaw render the QR up front, capture the
// resulting bot token + identity, store the secret in OpenShell as a
// provider credential, and seed the upstream plugin's on-disk account store
// at image-build time via the zalo-clawbot.seedOpenClawAccount hook — so the
// plugin starts already logged in and never drives its own QR login inside
// the sandbox (OpenClaw's `channels login` only supports WhatsApp anyway).
//
// Endpoints (Zalo Bot Platform session service):
//   GET <base>/agent/request-login
//     → { loginUrl, zbsk }                 (zbsk session token, ~5 min TTL)
//   GET <base>/agent/get-login-status?zbsk=<zbsk>
//     → { isLogin, botToken?, botId?, ownerId?, oaId? }  (poll; 498 = expired)

/** Default Zalo session service. The login URL it returns is the zalo.me
 *  mini-app deep link the operator opens on their phone. */
export const ZALOCLAWBOT_SESSION_SERVICE_URL = "https://bot.zaloplatforms.com";

/** zbsk session token TTL — the server expires it after ~5 minutes. */
export const ZALOCLAWBOT_ZBSK_TTL_MS = 5 * 60_000;

/** Hard cap on a single HTTP request (request-login or one status poll). */
export const ZALOCLAWBOT_REQUEST_TIMEOUT_MS = 10_000;

/** Minimal fetch contract — covers the global `fetch` and any test fake. */
export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface ZaloClawbotLoginSession {
  /** Mini-app deep link the operator scans/opens in Zalo. Safe to render. */
  loginUrl: string;
  /** Session token to pass to subsequent status polls. Treat as secret-ish. */
  zbsk: string;
}

export interface ZaloClawbotLoginStatus {
  /** True once the user confirmed and a bot token is available. */
  connected: boolean;
  /** Server says the zbsk/QR expired — caller should refresh. */
  expired: boolean;
  botToken?: string;
  botId?: string;
  ownerId?: string;
  oaId?: string;
  /** Human-readable detail for non-connected, non-expired outcomes. */
  message?: string;
}

export class ZaloClawbotQrError extends Error {
  constructor(
    public readonly kind: "network" | "http" | "parse",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ZaloClawbotQrError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Responses may be wrapped in a `{ result: {...} }` envelope or be flat. */
function unwrapEnvelope(raw: unknown): Record<string, unknown> {
  if (isRecord(raw) && isRecord(raw.result)) return raw.result;
  return isRecord(raw) ? raw : {};
}

function resolveBaseUrl(input?: string): string {
  const trimmed = input?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : ZALOCLAWBOT_SESSION_SERVICE_URL;
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function getJson(
  url: string,
  transport: FetchLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", external, { once: true });
  }
  try {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await transport(url, { method: "GET", signal: controller.signal });
    } catch (err) {
      throw new ZaloClawbotQrError("network", `request failed: ${stringify(err)}`);
    }
    let body: Record<string, unknown> = {};
    try {
      body = unwrapEnvelope(await res.json());
    } catch {
      body = {};
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", external);
  }
}

/** Request a fresh login session. Throws on transport/HTTP/parse failure so
 *  the orchestrator can abort the attempt cleanly. */
export async function requestZaloClawbotLogin(params: {
  sessionServiceUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ZaloClawbotLoginSession> {
  const transport = params.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!transport) throw new ZaloClawbotQrError("network", "global fetch unavailable; pass fetch");
  const base = resolveBaseUrl(params.sessionServiceUrl);
  const { status, ok, body } = await getJson(
    `${base}/agent/request-login`,
    transport,
    params.timeoutMs ?? ZALOCLAWBOT_REQUEST_TIMEOUT_MS,
    params.signal,
  );
  if (!ok) throw new ZaloClawbotQrError("http", `request-login returned ${status}`, status);
  const loginUrl = typeof body.loginUrl === "string" ? body.loginUrl : undefined;
  const zbsk = typeof body.zbsk === "string" ? body.zbsk : undefined;
  if (!loginUrl || !zbsk) {
    throw new ZaloClawbotQrError("parse", "request-login missing loginUrl or zbsk");
  }
  return { loginUrl, zbsk };
}

/** Single status poll. Network errors and gateway 5xx surface as a benign
 *  pending result so the orchestrator simply re-polls until its deadline. */
export async function pollZaloClawbotLoginStatus(params: {
  zbsk: string;
  sessionServiceUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ZaloClawbotLoginStatus> {
  const transport = params.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!transport) throw new ZaloClawbotQrError("network", "global fetch unavailable; pass fetch");
  const base = resolveBaseUrl(params.sessionServiceUrl);
  const url = `${base}/agent/get-login-status?zbsk=${encodeURIComponent(params.zbsk)}`;
  let result: { status: number; ok: boolean; body: Record<string, unknown> };
  try {
    result = await getJson(
      url,
      transport,
      params.timeoutMs ?? ZALOCLAWBOT_REQUEST_TIMEOUT_MS,
      params.signal,
    );
  } catch {
    // Transport error / timeout — treat as pending; the loop owns the deadline.
    return { connected: false, expired: false };
  }
  const { status, body } = result;
  if (status === 498 || body.code === 498 || body.error_code === 498) {
    return { connected: false, expired: true, message: "QR/session expired." };
  }
  if (status >= 500) return { connected: false, expired: false };
  // Truthy (not strictly `true`) — the server may signal login with 1/"true".
  if (body.isLogin && typeof body.botToken === "string") {
    return {
      connected: true,
      expired: false,
      botToken: body.botToken,
      botId: body.botId !== undefined ? String(body.botId) : undefined,
      ownerId: body.ownerId !== undefined ? String(body.ownerId) : undefined,
      oaId: body.oaId !== undefined ? String(body.oaId) : undefined,
    };
  }
  return { connected: false, expired: false };
}
