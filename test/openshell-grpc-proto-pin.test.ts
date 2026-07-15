// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyOpenShellGrpcProtoPin } from "../scripts/checks/openshell-grpc-proto-pin";

function withFixture(
  blueprintVersion: string,
  protoSource: string,
  assertion: (root: string, digest: string) => void,
  packageFiles: string[] = ["third_party/openshell/"],
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-proto-pin-"));
  const protoDir = path.join(root, "third_party/openshell/v1.2.3/proto");
  fs.mkdirSync(path.join(root, "nemoclaw-blueprint"), { recursive: true });
  fs.mkdirSync(protoDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "nemoclaw-blueprint/blueprint.yaml"),
    `max_openshell_version: "${blueprintVersion}"\n`,
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ files: packageFiles }));
  fs.writeFileSync(path.join(protoDir, "openshell.proto"), protoSource);
  try {
    assertion(root, createHash("sha256").update(protoSource).digest("hex"));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

describe("OpenShell gRPC protocol pin", () => {
  it("accepts protocol sources bound to the supported OpenShell version", () => {
    withFixture("1.2.3", 'syntax = "proto3";\n', (root, digest) => {
      expect(
        verifyOpenShellGrpcProtoPin(root, {
          version: "1.2.3",
          files: { "openshell.proto": digest },
        }),
      ).toEqual([]);
    });
  });

  it("rejects version drift and modified protocol sources", () => {
    withFixture("1.2.4", "modified\n", (root) => {
      expect(
        verifyOpenShellGrpcProtoPin(root, {
          version: "1.2.3",
          files: { "openshell.proto": "a".repeat(64) },
        }),
      ).toEqual([
        "OpenShell gRPC proto version: expected blueprint maximum 1.2.4, found 1.2.3",
        expect.stringMatching(
          /^third_party\/openshell\/v1\.2\.3\/proto\/openshell\.proto: expected SHA-256 a{64}, found [a-f0-9]{64}$/,
        ),
      ]);
    });
  });

  it("rejects a declared protocol source that is missing", () => {
    withFixture("1.2.3", 'syntax = "proto3";\n', (root, digest) => {
      expect(
        verifyOpenShellGrpcProtoPin(root, {
          version: "1.2.3",
          files: {
            "openshell.proto": digest,
            "sandbox.proto": "a".repeat(64),
          },
        }),
      ).toEqual([
        expect.stringMatching(
          /^third_party\/openshell\/v1\.2\.3\/proto\/sandbox\.proto: failed to read \(/,
        ),
      ]);
    });
  });

  it("rejects protocol sources omitted from the package", () => {
    withFixture(
      "1.2.3",
      'syntax = "proto3";\n',
      (root, digest) => {
        expect(
          verifyOpenShellGrpcProtoPin(root, {
            version: "1.2.3",
            files: { "openshell.proto": digest },
          }),
        ).toEqual([
          "package.json: files must include third_party/openshell/ for runtime gRPC loading",
        ]);
      },
      ["dist/"],
    );
  });
});
