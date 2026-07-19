// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";
import {
  type OpenShellSandboxControl,
  OpenShellExecRequestValidationError,
  openShellExecRequestValidationFailure,
  type SandboxExecResult,
} from "./sandbox-control";
import { execSandboxReadOnlyWithGrpcFallback } from "./sandbox-control-routing";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

function dependencies(grpcResult: SandboxExecResult | Error, cliResult?: SandboxExecResult) {
  const close = vi.fn();
  const grpcExec = vi.fn(() =>
    grpcResult instanceof Error ? Promise.reject(grpcResult) : Promise.resolve(grpcResult),
  );
  const grpc: GrpcOpenShellSandboxControl = { close, exec: grpcExec };
  const cliExec = vi.fn(async () => cliResult ?? { status: 0, stdout: "cli", stderr: "" });
  const cli: OpenShellSandboxControl = { exec: cliExec };
  const createCli = vi.fn(() => cli);
  const createGrpc = vi.fn(() => grpc);
  const debug = vi.fn();
  return {
    close,
    grpcExec,
    cliExec,
    createCli,
    createGrpc,
    debug,
    deps: { createCli, createGrpc, debug },
  };
}

const request = {
  sandboxName: "alpha",
  command: ["openclaw", "sessions", "list"] as const,
  maxOutputBytes: 4096,
};

describe("read-only OpenShell sandbox control routing", () => {
  it.each([
    ["too many session arguments", ["openclaw", "sessions", "list", ...Array(1022).fill("x")]],
    [
      "an oversized UTF-8 session argument",
      ["openclaw", "sessions", "list", "é".repeat(16 * 1024 + 1)],
    ],
    ["a NUL session argument", ["openclaw", "sessions", "list", "bad\0arg"]],
  ])("rejects %s before creating either transport", async (_label, command) => {
    const test = dependencies({ status: 0, stdout: "unused", stderr: "" });

    const result = await execSandboxReadOnlyWithGrpcFallback(
      "nemoclaw",
      { sandboxName: "alpha", command },
      test.deps,
    );

    expect(result.error).toBeInstanceOf(OpenShellExecRequestValidationError);
    expect(test.createGrpc).not.toHaveBeenCalled();
    expect(test.grpcExec).not.toHaveBeenCalled();
    expect(test.cliExec).not.toHaveBeenCalled();
    expect(test.createCli).not.toHaveBeenCalled();
  });

  it("routes session arguments containing line endings without rewriting them", async () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });
    const multilineRequest = { ...request, command: [...request.command, "line one\nline two\r"] };

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", multilineRequest, test.deps),
    ).resolves.toMatchObject({ status: 0 });

    expect(test.grpcExec).toHaveBeenCalledWith({
      ...multilineRequest,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("accepts the exact session count and UTF-8 byte boundaries", async () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });
    const command = [
      "openclaw",
      "sessions",
      "list",
      "é".repeat(16 * 1024),
      ...Array(1020).fill("x"),
    ];

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", { sandboxName: "alpha", command }, test.deps),
    ).resolves.toMatchObject({ status: 0 });

    expect(command).toHaveLength(1024);
    expect(test.grpcExec).toHaveBeenCalledOnce();
    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("does not route a thrown typed validation error through the CLI", async () => {
    const error = new OpenShellExecRequestValidationError({ kind: "empty-command" });
    const test = dependencies(error);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(openShellExecRequestValidationFailure(error));

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("does not replay a rejected gRPC execution through the CLI", async () => {
    const error = new Error("stream rejected after dispatch");
    const test = dependencies(error);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual({ status: null, stdout: "", stderr: "", error });

    expect(test.grpcExec).toHaveBeenCalledOnce();
    expect(test.cliExec).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("retries a rejected explicit pre-dispatch lookup failure through the CLI", async () => {
    const cause = new Error("UNAVAILABLE");
    const test = dependencies(new OpenShellGrpcPreDispatchError(cause));

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual({ status: 0, stdout: "cli", stderr: "" });

    expect(test.cliExec).toHaveBeenCalledOnce();
    expect(test.createCli).toHaveBeenCalledWith("nemoclaw");
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("before dispatch"), cause);
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("fails closed when the scoped CLI refuses an endpoint override after lookup", async () => {
    const cause = new Error("UNAVAILABLE");
    const refusal = new Error("Unset OPENSHELL_GATEWAY_ENDPOINT and retry");
    const test = dependencies(new OpenShellGrpcPreDispatchError(cause));
    test.createCli.mockImplementation(() => {
      throw refusal;
    });

    await expect(execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps)).rejects.toBe(
      refusal,
    );

    expect(test.cliExec).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("uses direct gRPC with a bounded deadline", async () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw-9090", request, test.deps),
    ).resolves.toEqual({ status: 0, stdout: "grpc", stderr: "" });

    expect(test.createGrpc).toHaveBeenCalledWith("nemoclaw-9090");
    expect(test.grpcExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.cliExec).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("does not replay a completed non-zero command through the CLI", async () => {
    const result = { status: 2, stdout: "", stderr: "unknown flag" };
    const test = dependencies(result);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(result);

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("retries a pre-dispatch gRPC lookup failure with the same bounded deadline", async () => {
    const grpcError = new Error("UNAVAILABLE");
    const cliResult = { status: 0, stdout: "cli", stderr: "" };
    const test = dependencies(
      {
        status: null,
        stdout: "",
        stderr: "",
        error: new OpenShellGrpcPreDispatchError(grpcError),
      },
      cliResult,
    );

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(cliResult);

    expect(test.cliExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.createCli).toHaveBeenCalledWith("nemoclaw");
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("before dispatch"), grpcError);
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("does not replay a post-dispatch gRPC stream failure", async () => {
    const grpcError = new Error("stream reset");
    const result = { status: null, stdout: "partial", stderr: "", error: grpcError };
    const test = dependencies(result);

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", request, test.deps),
    ).resolves.toEqual(result);

    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("uses the CLI when gateway configuration cannot create a gRPC client", async () => {
    const test = dependencies({ status: 0, stdout: "unused", stderr: "" });
    const error = new Error("edge tunnel required");
    test.createGrpc.mockImplementation(() => {
      throw error;
    });

    await expect(execSandboxReadOnlyWithGrpcFallback("edge", request, test.deps)).resolves.toEqual({
      status: 0,
      stdout: "cli",
      stderr: "",
    });

    expect(test.grpcExec).not.toHaveBeenCalled();
    expect(test.createCli).toHaveBeenCalledWith("edge");
    expect(test.cliExec).toHaveBeenCalledWith({
      ...request,
      timeoutMs: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(test.debug).toHaveBeenCalledWith(expect.stringContaining("configuration failed"), error);
  });

  it("fails closed when the scoped CLI refuses an endpoint override after configuration", async () => {
    const configurationError = new Error("edge tunnel required");
    const refusal = new Error("Unset OPENSHELL_GATEWAY_ENDPOINT and retry");
    const test = dependencies({ status: 0, stdout: "unused", stderr: "" });
    test.createGrpc.mockImplementation(() => {
      throw configurationError;
    });
    test.createCli.mockImplementation(() => {
      throw refusal;
    });

    await expect(execSandboxReadOnlyWithGrpcFallback("edge", request, test.deps)).rejects.toBe(
      refusal,
    );

    expect(test.grpcExec).not.toHaveBeenCalled();
    expect(test.cliExec).not.toHaveBeenCalled();
  });

  it("does not let close failures replace a successful result", async () => {
    const test = dependencies({ status: 0, stdout: "grpc", stderr: "" });
    const closeError = new Error("close failed");
    test.close.mockImplementation(() => {
      throw closeError;
    });

    await expect(
      execSandboxReadOnlyWithGrpcFallback("nemoclaw", { ...request, timeoutMs: 0 }, test.deps),
    ).resolves.toEqual({ status: 0, stdout: "grpc", stderr: "" });

    expect(test.grpcExec).toHaveBeenCalledWith({ ...request, timeoutMs: 0 });
    expect(test.debug).toHaveBeenCalledWith(
      "OpenShell direct gRPC client close failed",
      closeError,
    );
  });
});
