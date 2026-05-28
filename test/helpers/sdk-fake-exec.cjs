#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function findFakeOpenshell() {
  const homeEntries = process.env.HOME
    ? [path.join(process.env.HOME, "bin"), path.join(process.env.HOME, ".local", "bin")]
    : [];
  const pathEntries = [
    ...homeEntries,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of pathEntries) {
    const candidate = path.join(dir, "openshell");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

let request;
try {
  request = JSON.parse(fs.readFileSync(0, "utf-8"));
} catch (error) {
  fail(`sdk fake exec could not parse request: ${error.message}`, 64);
}

const sandboxName = request && typeof request.sandboxName === "string" ? request.sandboxName : "";
const argv = Array.isArray(request?.argv) ? request.argv.filter((entry) => typeof entry === "string") : [];
const input = Buffer.from(
  typeof request?.inputBase64 === "string" ? request.inputBase64 : "",
  "base64",
);

if (!sandboxName || argv.length === 0) {
  fail("usage: sdk-fake-exec requires { sandboxName, argv } JSON on stdin", 64);
}

const openshell = findFakeOpenshell();
const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
if (!openshell || !home || !path.resolve(openshell).startsWith(`${home}${path.sep}`)) {
  fail("sdk fake transport could not find the hermetic fake openshell under HOME", 127);
}

function normalizeExecArgvForFake(argv, input) {
  if (
    input.length > 0 &&
    (argv[0] === "sh" || argv[0] === "bash") &&
    (argv[1] === "-s" || argv[1] === "-")
  ) {
    return [argv[0], "-c", input.toString("utf-8")];
  }
  return argv;
}

const result = spawnSync(
  openshell,
  ["sandbox", "exec", "--name", sandboxName, "--", ...normalizeExecArgvForFake(argv, input)],
  {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  },
);

if (result.error) fail(result.error.message);

process.stdout.write(
  JSON.stringify({
    status: result.status ?? 1,
    stdoutBase64: Buffer.from(result.stdout || "").toString("base64"),
    stderrBase64: Buffer.from(result.stderr || "").toString("base64"),
  }),
);
