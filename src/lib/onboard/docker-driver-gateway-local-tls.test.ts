// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dockerDriverGatewayLocalTlsBundleIsComplete,
  ensureDockerDriverGatewayLocalTlsBundle,
  getDockerDriverGatewayLocalTlsBundle,
} from "./docker-driver-gateway-local-tls";

const TEST_CERT_VALID_AT = new Date("2026-07-07T00:00:00.000Z");
const TEST_CERT_SKEW_BOUNDARY_NOT_YET_VALID_AT = new Date("2026-07-06T09:13:48.000Z");
const TEST_CERT_NOT_YET_VALID_AT = new Date("2026-07-06T09:13:47.000Z");
const TEST_CERT_SKEW_BOUNDARY_EXPIRED_AT = new Date("2036-07-03T09:23:48.000Z");
const TEST_CERT_EXPIRED_AT = new Date("2036-07-03T09:23:49.000Z");

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDcjCCAlqgAwIBAgIUG9yAEBghuyKD/R8r8OL5IPibmKEwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNbmVtb2NsYXctdGVzdDAeFw0yNjA3MDYwOTE4NDhaFw0z
NjA3MDMwOTE4NDhaMBgxFjAUBgNVBAMMDW5lbW9jbGF3LXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCcI50FZ5mc1Awsfd34mLOa8Xm3DpW0Hh1D
0tupmASawQEGMwxEgbaoQTo+SckEYQ14baH1AwikzKWBjnCvqPdrxZ2Ql1JRybtk
UDbXX4AH0KyrUd8ZjxyNUa4HI0ZzZkJ19titK2X1DX+T3jAen6napbBwe4WK6+zf
ZVXwXIBmv/rcVQk1guJgBNzO4HW55a9lToeI9rhbyI1HBajPignQ0eObI3WORk4X
Hg/U/ZUfO1g0i2ziS7umbD2KVvjxutetYMR6PsFOg7Im7suHr4lwvKB5DYiP8mOz
/DvrIncFeG2TCCcDROSUmIcVRfe82mmGf9fYcrpQo5Yg4LgNwxw9AgMBAAGjgbMw
gbAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAqQwHQYDVR0OBBYEFKoc
BmlDpKXIrqBnTjn7w+spUyTxMB8GA1UdIwQYMBaAFKocBmlDpKXIrqBnTjn7w+sp
UyTxME0GA1UdEQRGMESCF2hvc3Qub3BlbnNoZWxsLmludGVybmFsghhob3N0LmNv
bnRhaW5lcnMuaW50ZXJuYWyCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG9w0BAQsF
AAOCAQEABn0f8iVLD9w1rem8x/Y1/Hlw4JqiqSlVsvoDhDM6/m6JSjvggY7t+FNh
cn1NRoKsi4RjndrdBzhO6UWMv5oCOitJU2MFvHK/9FNLnZ4WT92eO1tzz4SMHkNN
zCkYm0cy1Bs6IE7bSVttak1Hy6havAg7Hv171cE1RX+TPm+no/BCVfity65iy3AA
Izyq5bN5PbENmpz6ar/AzuE5b3HuGSLdP02co2vgRnSEp0ysyKAfK/BFe/xkKgrg
m8QQDANvfFJ2jvSSghEBZ+iMWrOeVkvHp+KfAqgaFIag8kWcYmdqqgJDBGhkdVQY
SLkGDhHgdv8muWjOxXxnAcvdCecIhw==
-----END CERTIFICATE-----
`;

const TEST_CERT_WITHOUT_REQUIRED_SAN_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUHcSxS4dERobRjaJRbfMQoMPf3K8wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNbmVtb2NsYXctdGVzdDAeFw0yNjA2MjYxOTQ5NTRaFw0z
NjA2MjMxOTQ5NTRaMBgxFjAUBgNVBAMMDW5lbW9jbGF3LXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDXwhjS2SOCpElldjSxB/qwXVEnliSKHJIU
1x32jmobOAmaIsJNJ/aMtxTTci4YQcCBGG9RmbGGemzR88HqvJkI0Oed/39dTYgF
zlIRlgJwU4bh+uvU6UjU4+EH9KYOH8SXJtwI0PDUBwzQTksX3/0EtphwtWXZ4KwN
5NkFC+4cqVL875Mc5XtFYHfxqusw3+wfgNpHJtnGsPPNNGaK8CNpsmB1P0oQ88jU
G4G4z40HqaHr2LEh8yTw9TukktbaXtosgNvwuo8Ujq/48ETdyLsSi11aeUGh6l7j
bP5oWyZpqMSSTLsmrBxuGWbEOpduzFNxjuKmoSC+NkLVf9Ucn+EfAgMBAAGjUzBR
MB0GA1UdDgQWBBR0qPxRGOcKDuV8fcjJIZjl0KeWDjAfBgNVHSMEGDAWgBR0qPxR
GOcKDuV8fcjJIZjl0KeWDjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQDXQwNw1y81lJ+A8c7oykoOuZc4JVyUzVZK3XskcqO+rwD32STwUGrK5uN5
Q5QB403HoippsySPy9QGdnMci8twQce3wUEgaaxp85KCAbXUT+asDZ863EpfectN
Gfw2rQW1Oe9C2EsxaM89hDzDMWiGDs/OynNctXIX94jCZ8wDWAwcYLoCbYiH53HK
OxHpiHZoAw7VOjZ/mDF6L/teqGE+SQKJD1VyLW0SFhZH9zbZzy68nNSxpba87bQz
pBIexcT1Wv4GD4R5P7jmS3DByQiuwURc4UspT6lcVmOsN7pXqh5GocK7uF9TYEw6
/oEs5OzkyB0H/y7p/KQmTEYO3uTa
-----END CERTIFICATE-----
`;

const TEST_KEY_LABEL = "PRIVATE " + "KEY";
const TEST_KEY_PEM = [
  `-----BEGIN ${TEST_KEY_LABEL}-----`,
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCcI50FZ5mc1Aws",
  "fd34mLOa8Xm3DpW0Hh1D0tupmASawQEGMwxEgbaoQTo+SckEYQ14baH1AwikzKWB", // gitleaks:allow
  "jnCvqPdrxZ2Ql1JRybtkUDbXX4AH0KyrUd8ZjxyNUa4HI0ZzZkJ19titK2X1DX+T",
  "3jAen6napbBwe4WK6+zfZVXwXIBmv/rcVQk1guJgBNzO4HW55a9lToeI9rhbyI1H",
  "BajPignQ0eObI3WORk4XHg/U/ZUfO1g0i2ziS7umbD2KVvjxutetYMR6PsFOg7Im",
  "7suHr4lwvKB5DYiP8mOz/DvrIncFeG2TCCcDROSUmIcVRfe82mmGf9fYcrpQo5Yg",
  "4LgNwxw9AgMBAAECggEABeAJLoThcNdBxgLOcWY9i9z+OXchBvADJeQvQ8hmk/Qj",
  "N7qAAavn1Zjuuh1IpROJ0Dg/2dpNXvYcXC2h69otxS5gaWpoPI+cr3+dMKl1RdYC",
  "SUgBXxLVfjPOmpInOnxkj8/EA3AYnAnv/P5lTSGw4HtPkkvzkHCkLxu/ChZQ9oy/",
  "rvnbFDOhBeKV6Aq0r7PBSBF2cRsOnJSHooLyDVl5XJijF/bzG1OnZEgrqmkscB1e",
  "qKvXhZmIJsd1PLPnUOuvxzrn0e/pgg2d4Q+Iye3nunRnqgnBMw3Ujt2h8GsttwEK",
  "3l9eMohQsTt/3uuwPWDtvz18Yac+JCVcdJAQzBujAQKBgQDUXJ3a8a7cERVb9EG8",
  "yAiF5JK2ReMuv8czNqHcg4qoNNR0NTKc4BvnfeKPhXXZytthnVqeKxgSCglmt84f",
  "/AF6Eg4KnjZP05pGOQFsRY2LNiapOg1laSgKHnUzW1RrT66Msu441LhGx7mcbL62",
  "K/7RFqoiu+Z5tp8S0a7ttTnUHQKBgQC8OWEC3ZqX5yoTKd5jJ2KP4TOQN4Bcl7v7",
  "sdxebu1zqlDum+shHMAF2kOanlcPSI9twyem6OwO5iIPEl0+nCJZxjryqTFnGkAB",
  "+JOxvZjKE/Q28MlnYDH+kpnX+PQ8EUWipiZUIqlZVNgofI7RVpoTv28uPthDkmMg",
  "fQZ2p82uoQKBgQDKgtviK7GlmQD2ZLK/tT4zeOrTuUfRj/8FfqbSY/q5N1AW1ZhD",
  "c5AIrMp+NTZSkBmvN+BvjwbwRPP8KXH+nFJIN6l+RKvkahTnvHr35kf5ppUtsfeO",
  "ar5NEAiSBhk2EJGTCRsVxP1KOjJt0mH31XK1r9hlMSyziwydZKpdcwIHnQKBgDVf",
  "r/q4DFZ23p+Ah+dmC7TxD0Yd9vBKtquwy+SbYAokib6fyBUjqe/+7JyzucxDryhY",
  "5q2V7xpqd83+TyKp87OxWpXlFHVAJFZqvrbwJJto/R93OCVwSbz+pVFw7xD5dN2i",
  "b8v76DnErWcNqxIBlL900Xozp+/BWwqjaWnMO68BAoGAFE+rfGWAABfu7eJ3s4JA",
  "66xVNpDMzNj1WlIUjFj6pE2N+31A8+YxE/ouLUwms6DaaWcxvDQ+qfEfOXo9RpN2",
  "Xu3/voV0Pd8Vxuc8HEjI1KII/UkD5raer08029WZhi49zLwgKdEfgNWcCXWnKUzh",
  "7o3R9ORT5iZ5axqyX+G9C5k=",
  `-----END ${TEST_KEY_LABEL}-----`,
  "",
].join("\n");

const TEST_KEY_WITHOUT_REQUIRED_SAN_PEM = [
  `-----BEGIN ${TEST_KEY_LABEL}-----`,
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDXwhjS2SOCpEll",
  "djSxB/qwXVEnliSKHJIU1x32jmobOAmaIsJNJ/aMtxTTci4YQcCBGG9RmbGGemzR",
  "88HqvJkI0Oed/39dTYgFzlIRlgJwU4bh+uvU6UjU4+EH9KYOH8SXJtwI0PDUBwzQ",
  "TksX3/0EtphwtWXZ4KwN5NkFC+4cqVL875Mc5XtFYHfxqusw3+wfgNpHJtnGsPPN",
  "NGaK8CNpsmB1P0oQ88jUG4G4z40HqaHr2LEh8yTw9TukktbaXtosgNvwuo8Ujq/4",
  "8ETdyLsSi11aeUGh6l7jbP5oWyZpqMSSTLsmrBxuGWbEOpduzFNxjuKmoSC+NkLV",
  "f9Ucn+EfAgMBAAECggEAXRAPfQLD2lnafrUZzTJP4zqdAqI0aI4iRHL1LaAIDG2D",
  "VsSfYoBWTCO8C+g4EaZqzkQn396XQBYWUgj+H63xpGfXP8MwwKHshfSUWZmGu8SL",
  "bXW5u0BUdd9E9RWFepohRcExL2xQNGRGFqNuqIGotRu9bQARSoUqMWQAZ7jZn+pu",
  "ZhoqfMIY6B5UHZis5gyQAc6ixfw6PhZZzTORNP9qoqvpjjlSS1x6DFadMTtEhZX3",
  "vwC3jL+LupvRs/lOo+RYRPj5IYp8hkH68NZ4GJ9py404/oxbPc3u3KJiRsOoiAAG",
  "zUYRarxLX3dZM25RohK98MCAbLCV/1L/KJ/9yiUEAQKBgQDvVooBVeS0/KpC2U1n",
  "NymCdQfgvNcyMbc+tyAX3RcPqbSOaSeuN0bM8hdKUBLYmH3eDtFbDH8guSz93aFr",
  "9dtw9X/qBFNjv8LW/Ee4+1gjg4uMgn6AZXylvTsXptyer3Ec+DA0sBylhPcegKAL",
  "otpx4dLrIZwyZrpHYsYDgiy+gQKBgQDmx1Hk4vaUkEx3IizOktt8/Qp78Y+ERzIS",
  "8tH+i4BUdvB83RUtUpGV1Jt6GaeIoYAxXKTj/7n/j8auSv211Kf108XhM3q2Pwnt",
  "B6ht5hEU8RGGVN68pvRv1+btFbL9bLEEsA5Dut1dX9qWaW04JneM1iIJlb7073lj",
  "RYZuJawPnwKBgQC5wp8mXjY+ywSTEfnjrIrJOHA+3BLiYHfrc1KzcuQdQghjp/Ym",
  "X7zSAOxWv0OBXQoEOdgAJPjeuxrShxxsoMwLJmB7j5Pxjbp6BiDc0CgemFDNY9Mv",
  "cJWIRhEBUH9Xoq/WXkN8AVyak1MCF68gmOuXDEEaQmHrNJRMJ7usqXJ1AQKBgH0L",
  "7ZT/Yir30WcQLoU0UBf2qJKmPmSnizt3NVAe2Mdrtz2BMfNf9SDhlelgM0Y2dFbK",
  "41HjhC41Aqv4WGcJNoVeXa98DHbpy4ATETGTYxgc06kdHZ/NO0/LBgbbJiRpm7V1",
  "jBUpEL+Cq9eqgpLVTRwT/1eAO3tOs1CWIJRYd1XzAoGAXStCv/MdhXGAMvKUqFea",
  "9I1eAIR4gOvGFuc7ZiXFQKqpPS18rDmKfAS0ljkMc5dVckFX3nCJ6d9z14XktH/G",
  "mCV/bGZgFwbG2uRAqHMQES3cg7uWB7Qui4ZehUVwPJAYGVl4V9mqNsjWsEJ0/TtC",
  "A9vJ/xk+U0mTEqPtau28lc4=",
  `-----END ${TEST_KEY_LABEL}-----`,
  "",
].join("\n");

function writeBundle(
  stateDir: string,
  certContent: string,
  keyContent: string,
): Record<string, string> {
  const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
  const contents = {
    [paths.caPath]: certContent,
    [paths.serverCertPath]: certContent,
    [paths.serverKeyPath]: keyContent,
    [paths.clientCertPath]: certContent,
    [paths.clientKeyPath]: keyContent,
  };
  for (const [filePath, content] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return contents;
}

function useTestCertificateClock(now = TEST_CERT_VALID_AT): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

function expectCompleteBundleReusedAt(now: Date): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
  writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
  let certgenCalls = 0;
  useTestCertificateClock(now);
  try {
    ensureDockerDriverGatewayLocalTlsBundle({
      env: { PATH: "/usr/bin" },
      gatewayBin: "/opt/openshell/openshell-gateway",
      stateDir,
      spawnSyncImpl: (() => {
        certgenCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      }) as never,
    });

    expect(certgenCalls).toBe(0);
    expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("docker-driver-gateway-local-tls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs OpenShell certgen into the NemoClaw-owned gateway TLS directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    useTestCertificateClock();
    try {
      const bundle = ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: ((
          command: string,
          args: string[],
          options?: { env?: NodeJS.ProcessEnv },
        ) => {
          calls.push({ command, args, env: options?.env });
          const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          expect(paths.localTlsDir).toBe(path.join(stateDir, "tls"));
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(bundle.localTlsDir).toBe(path.join(stateDir, "tls"));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "/opt/openshell/openshell-gateway",
        args: [
          "generate-certs",
          "--output-dir",
          path.join(stateDir, "tls"),
          "--server-san",
          "host.openshell.internal",
          "--server-san",
          "host.containers.internal",
          "--server-san",
          "localhost",
          "--server-san",
          "127.0.0.1",
        ],
      });
      expect(calls[0]?.env?.OPENSHELL_LOCAL_TLS_DIR).toBe(path.join(stateDir, "tls"));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves an existing complete mTLS bundle without regenerating certs", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    const contents = writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
    const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
    fs.chmodSync(paths.serverKeyPath, 0o644);
    fs.chmodSync(paths.clientKeyPath, 0o644);
    let certgenCalls = 0;
    useTestCertificateClock();
    try {
      const bundle = ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(bundle.localTlsDir).toBe(path.join(stateDir, "tls"));
      expect(certgenCalls).toBe(0);
      for (const [filePath, content] of Object.entries(contents)) {
        expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
      }
      expect(fs.statSync(paths.serverKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(paths.clientKeyPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but wrong-SAN mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, TEST_CERT_WITHOUT_REQUIRED_SAN_PEM, TEST_KEY_WITHOUT_REQUIRED_SAN_PEM);
    let certgenCalls = 0;
    useTestCertificateClock();
    try {
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(false);

      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(certgenCalls).toBe(1);
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but unparsable mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, "not a certificate\n", "not a private key\n");
    let certgenCalls = 0;
    useTestCertificateClock();
    try {
      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      const paths = getDockerDriverGatewayLocalTlsBundle(stateDir);
      expect(certgenCalls).toBe(1);
      expect(fs.readFileSync(paths.caPath, "utf-8")).toBe(TEST_CERT_PEM);
      expect(fs.readFileSync(paths.serverKeyPath, "utf-8")).toBe(TEST_KEY_PEM);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but expired mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
    let certgenCalls = 0;
    useTestCertificateClock(TEST_CERT_EXPIRED_AT);
    try {
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(false);

      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          vi.setSystemTime(TEST_CERT_VALID_AT);
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(certgenCalls).toBe(1);
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("regenerates a complete but not-yet-valid mTLS bundle before reuse", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-"));
    writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
    let certgenCalls = 0;
    useTestCertificateClock(TEST_CERT_NOT_YET_VALID_AT);
    try {
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(false);

      ensureDockerDriverGatewayLocalTlsBundle({
        env: { PATH: "/usr/bin" },
        gatewayBin: "/opt/openshell/openshell-gateway",
        stateDir,
        spawnSyncImpl: (() => {
          certgenCalls += 1;
          vi.setSystemTime(TEST_CERT_VALID_AT);
          writeBundle(stateDir, TEST_CERT_PEM, TEST_KEY_PEM);
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      });

      expect(certgenCalls).toBe(1);
      expect(dockerDriverGatewayLocalTlsBundleIsComplete(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reuses the bundle at the exact five-minute not-before skew transition", () => {
    expectCompleteBundleReusedAt(TEST_CERT_SKEW_BOUNDARY_NOT_YET_VALID_AT);
  });

  it("reuses the bundle at the exact five-minute not-after skew transition", () => {
    expectCompleteBundleReusedAt(TEST_CERT_SKEW_BOUNDARY_EXPIRED_AT);
  });
});
