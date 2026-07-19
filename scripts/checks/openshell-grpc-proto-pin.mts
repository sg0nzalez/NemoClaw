// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

interface OpenShellProtoPin {
  version: string;
  files: Readonly<Record<string, string>>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGED_PROTO_ROOT = "third_party/openshell/";

export const OPENSHELL_GRPC_PROTO_PIN: OpenShellProtoPin = {
  version: "0.0.85",
  files: {
    "datamodel.proto": "64d7ec700f2da4a9173e61e8af7431cf4537d0aa30f95a6a0d22b8798c8e17ee",
    "openshell.proto": "ddf72e4962430e86cb16a100a36f96ca11be40f326ff31141ee10a3d073e728e",
    "options.proto": "620c71e42f8fab5eb337ad297945c3638965993e4d8a8422830fcf5ab1faad6f",
    "sandbox.proto": "e25b7cb053cbac79c4f9c22c7c67da8290729e88015f4c1b0a3d3d15c893d356",
  },
};

function readFile(rootDir: string, relativePath: string, failures: string[]): Buffer | null {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath));
  } catch (error) {
    failures.push(`${relativePath}: failed to read (${(error as Error).message})`);
    return null;
  }
}

function blueprintOpenShellVersion(source: Buffer, failures: string[]): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(source.toString("utf8"));
  } catch (error) {
    failures.push(
      `nemoclaw-blueprint/blueprint.yaml: failed to parse (${(error as Error).message})`,
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push("nemoclaw-blueprint/blueprint.yaml: expected a mapping");
    return null;
  }
  const version = (parsed as Record<string, unknown>).max_openshell_version;
  if (typeof version !== "string" || !version) {
    failures.push("nemoclaw-blueprint/blueprint.yaml: max_openshell_version must be a string");
    return null;
  }
  return version;
}

function verifyProtocolSourcesArePackaged(source: Buffer, failures: string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    failures.push(`package.json: failed to parse (${(error as Error).message})`);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push("package.json: expected an object");
    return;
  }
  const files = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(files) || !files.includes(PACKAGED_PROTO_ROOT)) {
    failures.push(
      `package.json: files must include ${PACKAGED_PROTO_ROOT} for runtime gRPC loading`,
    );
  }
}

export function verifyOpenShellGrpcProtoPin(
  rootDir = REPO_ROOT,
  pin: OpenShellProtoPin = OPENSHELL_GRPC_PROTO_PIN,
): string[] {
  const failures: string[] = [];
  const blueprint = readFile(rootDir, "nemoclaw-blueprint/blueprint.yaml", failures);
  if (blueprint) {
    const supportedVersion = blueprintOpenShellVersion(blueprint, failures);
    if (supportedVersion && supportedVersion !== pin.version) {
      failures.push(
        `OpenShell gRPC proto version: expected blueprint maximum ${supportedVersion}, found ${pin.version}`,
      );
    }
  }

  const packageManifest = readFile(rootDir, "package.json", failures);
  if (packageManifest) verifyProtocolSourcesArePackaged(packageManifest, failures);

  const protoRoot = `third_party/openshell/v${pin.version}/proto`;
  for (const [fileName, expectedDigest] of Object.entries(pin.files)) {
    const relativePath = `${protoRoot}/${fileName}`;
    const source = readFile(rootDir, relativePath, failures);
    if (!source) continue;
    const actualDigest = createHash("sha256").update(source).digest("hex");
    if (actualDigest !== expectedDigest) {
      failures.push(`${relativePath}: expected SHA-256 ${expectedDigest}, found ${actualDigest}`);
    }
  }

  return failures;
}

function main(): void {
  const failures = verifyOpenShellGrpcProtoPin();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`OpenShell gRPC protocol sources match v${OPENSHELL_GRPC_PROTO_PIN.version}.`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
