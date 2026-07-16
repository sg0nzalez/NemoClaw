// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  ExactImageManifestError,
  type ExactImageManifestExpectations,
  exactImageManifestFailureCode,
  normalizedExactImageManifestJson,
  parseAndValidateExactImageManifest,
} from "./exact-image-manifest.mts";
import * as privateFile from "./private-file.ts";

// The root TypeScript package is exposed as CommonJS under `node --import
// tsx` / `npx tsx`, but as an ESM namespace under Node's strip-types runtime
// and Vitest. Normalize both representations so every supported entrypoint
// uses the same no-follow private-file writer.
const privateFileRuntime = (
  "default" in privateFile && privateFile.default ? privateFile.default : privateFile
) as typeof import("./private-file.ts");

const MAX_MANIFEST_BYTES = 64 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fs.constants.O_NONBLOCK ?? 0;

type ExactImageManifestCliOptions = ExactImageManifestExpectations & {
  manifest: string;
  output: string;
};

const ARGUMENT_FIELDS = {
  "--manifest": "manifest",
  "--output": "output",
  "--nemoclaw-sha": "nemoclawSha",
  "--requester-run-id": "requesterWorkflowRunId",
  "--requester-run-attempt": "requesterWorkflowRunAttempt",
  "--correlation-id": "correlationId",
  "--image-repository-sha": "imageRepositorySha",
  "--producer-run-id": "workflowRunId",
  "--producer-run-attempt": "workflowRunAttempt",
} as const;

function requestInvalid(message: string): never {
  throw new ExactImageManifestError("REQUEST_INVALID", message);
}

function positiveIntegerArgument(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    requestInvalid(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    requestInvalid(`${flag} exceeds the safe integer range`);
  }
  return parsed;
}

export function parseExactImageManifestCliArgs(
  argv: readonly string[],
): ExactImageManifestCliOptions {
  const values = new Map<keyof ExactImageManifestCliOptions, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as keyof typeof ARGUMENT_FIELDS | undefined;
    const value = argv[index + 1];
    if (!flag || !(flag in ARGUMENT_FIELDS)) {
      requestInvalid(`unknown argument ${JSON.stringify(flag ?? "")}`);
    }
    if (value === undefined || value.startsWith("--")) {
      requestInvalid(`${flag} requires a value`);
    }
    const field = ARGUMENT_FIELDS[flag];
    if (values.has(field)) {
      requestInvalid(`${flag} may be provided only once`);
    }
    values.set(field, value);
  }

  const requireValue = (field: keyof ExactImageManifestCliOptions, flag: string): string => {
    const value = values.get(field);
    if (value === undefined) requestInvalid(`${flag} is required`);
    return value;
  };

  return {
    manifest: requireValue("manifest", "--manifest"),
    output: requireValue("output", "--output"),
    nemoclawSha: requireValue("nemoclawSha", "--nemoclaw-sha"),
    requesterWorkflowRunId: requireValue("requesterWorkflowRunId", "--requester-run-id"),
    requesterWorkflowRunAttempt: positiveIntegerArgument(
      requireValue("requesterWorkflowRunAttempt", "--requester-run-attempt"),
      "--requester-run-attempt",
    ),
    correlationId: requireValue("correlationId", "--correlation-id"),
    imageRepositorySha: requireValue("imageRepositorySha", "--image-repository-sha"),
    workflowRunId: requireValue("workflowRunId", "--producer-run-id"),
    workflowRunAttempt: positiveIntegerArgument(
      requireValue("workflowRunAttempt", "--producer-run-attempt"),
      "--producer-run-attempt",
    ),
  };
}

function readManifestFile(file: string): string {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    throw new ExactImageManifestError(
      "ARTIFACT_MISSING_OR_INVALID",
      "manifest input could not be opened safely",
    );
  }

  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      throw new ExactImageManifestError(
        "ARTIFACT_MISSING_OR_INVALID",
        "manifest input must be one regular file",
      );
    }
    if (before.size > MAX_MANIFEST_BYTES) {
      throw new ExactImageManifestError(
        "ARTIFACT_MISSING_OR_INVALID",
        `manifest input exceeds ${MAX_MANIFEST_BYTES} bytes`,
      );
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length > MAX_MANIFEST_BYTES || after.size !== before.size || after.nlink !== 1) {
      throw new ExactImageManifestError(
        "ARTIFACT_MISSING_OR_INVALID",
        "manifest input changed while it was read",
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ExactImageManifestError(
        "ARTIFACT_MISSING_OR_INVALID",
        "manifest input must be valid UTF-8",
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function runExactImageManifestCli(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseExactImageManifestCliArgs(argv);
  const accepted = parseAndValidateExactImageManifest(readManifestFile(options.manifest), options);
  try {
    privateFileRuntime.writePrivateRegularFile(
      options.output,
      normalizedExactImageManifestJson(accepted),
    );
  } catch {
    throw new ExactImageManifestError(
      "OUTPUT_WRITE_FAILED",
      "accepted manifest output could not be written safely",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runExactImageManifestCli();
  } catch (error) {
    const code = exactImageManifestFailureCode(error);
    const message = error instanceof Error ? error.message : "unexpected manifest validation error";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
