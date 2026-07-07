// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AttemptJournalEntry,
  assertSetupRetryAllowed,
  type CampaignAttestation,
  classifyInvocationFailure,
  materializeAttemptJournal,
  nextSetupAttempt,
  readAttestedVllmConfiguration,
  recoverAttemptJournal,
  selectInspectedContainer,
} from "../../scripts/performance/tool-disclosure/execute";
import { validateCampaignAttestations } from "../../scripts/performance/tool-disclosure/run";
import {
  STATIC_CATALOG_SIZES,
  TOOL_DISCLOSURE_AGENTS,
  TOOL_DISCLOSURE_MODES,
} from "../../scripts/performance/tool-disclosure/schedule";
import type { ToolDisclosureManifest } from "../../scripts/performance/tool-disclosure/types";

const hex = (value: number): string => value.toString(16).padStart(64, "0");

function attestationFixture(): {
  manifest: ToolDisclosureManifest;
  attestations: CampaignAttestation[];
} {
  const cells = TOOL_DISCLOSURE_AGENTS.flatMap((agent) =>
    TOOL_DISCLOSURE_MODES.flatMap((mode) =>
      STATIC_CATALOG_SIZES.map((size) => `${agent}:${mode}:${size}`),
    ),
  );
  const sandboxDigest = `sha256:${"a".repeat(64)}`;
  const inferenceDigest = `sha256:${"b".repeat(64)}`;
  const manifest = {
    inference: { container_digest: inferenceDigest },
    environment: {
      sandbox_image_digests: Object.fromEntries(cells.map((cell) => [cell, sandboxDigest])),
    },
  } as ToolDisclosureManifest;
  const attestations = [1, 2].map(
    (campaign): CampaignAttestation => ({
      campaign_id: `campaign-${campaign}`,
      vllm_process_start_time_seconds: campaign,
      inference_container_id_sha256: hex(campaign),
      inference_config_sha256: hex(100),
      inference_image_digest: inferenceDigest,
      sandbox_cells: cells.map((cell, index) => ({
        cell,
        instance_id_sha256: hex(campaign * 100 + index),
        status_sha256: hex(campaign * 1_000 + index),
        image_digest: sandboxDigest,
      })),
    }),
  );
  return { manifest, attestations };
}

describe("tool-disclosure attempt journal", () => {
  it("gives timeout precedence over context-overflow text", () => {
    expect(
      classifyInvocationFailure({
        phase: "primary",
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: "maximum context length exceeded",
      }),
    ).toBeUndefined();
    expect(
      classifyInvocationFailure({
        phase: "primary",
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "maximum context length exceeded",
      }),
    ).toBe("context-overflow");
  });

  it("retries only failures that occur before agent invocation", () => {
    expect(() => assertSetupRetryAllowed(false, "run-before-invocation")).not.toThrow();
    expect(() =>
      assertSetupRetryAllowed(true, "run-after-invocation", new Error("private detail")),
    ).toThrow(/discard this campaign/u);
  });

  it("preserves exhausted setup attempts and refuses another resume", () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-attempt-journal-"));
    try {
      const entry = {
        raw: { run_id: "run-exhausted", failure_outcome: "setup-error" },
        run: { run_id: "run-exhausted", outcome: "setup-error" },
      } as unknown as AttemptJournalEntry;
      const attempts = [entry, structuredClone(entry)];
      const serialized = `${attempts.map((attempt) => JSON.stringify(attempt)).join("\n")}\n`;
      const file = path.join(output, "attempt-journal.jsonl");
      fs.writeFileSync(file, serialized);

      expect(nextSetupAttempt([entry], "run-exhausted", 1)).toBe(1);
      const recovered = recoverAttemptJournal(output);
      expect(recovered).toEqual(attempts);
      expect(() => nextSetupAttempt(recovered, "run-exhausted", 1)).toThrow(
        /exhausted setup retries/u,
      );
      expect(fs.readFileSync(file, "utf8")).toBe(serialized);
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous Docker inspect output regardless of order", () => {
    const expected = { Id: "expected", Image: "sha256:expected" };
    const other = { Id: "other", Image: "sha256:other" };
    expect(selectInspectedContainer([expected], expected.Id)).toEqual(expected);
    expect(selectInspectedContainer([other, expected], expected.Id)).toBeUndefined();
    expect(selectInspectedContainer([expected, other], expected.Id)).toBeUndefined();
  });

  it("attests vLLM arguments only from the intended process configuration", () => {
    const expected: ToolDisclosureManifest["inference"] = {
      api: "chat-completions",
      model_id: "example/model",
      model_revision: "revision-1",
      container_image: "registry.example/vllm:1.0.0",
      container_digest: `sha256:${"a".repeat(64)}`,
      vllm_version: "1.0.0",
      tool_call_parser: "tool-parser",
      reasoning_parser: "reasoning-parser",
      temperature: 0,
      concurrency: 1,
      prefix_caching_enabled: false,
      public_vllm_flags: ["--enable-auto-tool-choice", "--max-model-len 8192"],
    };
    const command =
      "vllm serve example/model --revision revision-1 " +
      "--tool-call-parser tool-parser --reasoning-parser reasoning-parser " +
      "--enable-auto-tool-choice --max-model-len 8192";
    expect(
      readAttestedVllmConfiguration(
        {
          Config: {
            Entrypoint: ["/bin/bash"],
            Cmd: ["-lc", command],
            Env: ["VLLM_USE_V1=1", "UNRELATED=ignored"],
          },
        },
        expected,
      ),
    ).toEqual({
      cmd: ["-lc", command],
      entrypoint: ["/bin/bash"],
      env: ["VLLM_USE_V1=1"],
    });

    const decoy = [
      expected.model_id,
      expected.model_revision,
      expected.tool_call_parser,
      expected.reasoning_parser,
      ...expected.public_vllm_flags,
    ].join(" ");
    expect(
      readAttestedVllmConfiguration(
        {
          Config: {
            Entrypoint: ["vllm"],
            Cmd: ["serve", "different/model"],
            Env: [`UNRELATED=${decoy}`],
            Labels: { unrelated: decoy },
          },
        },
        expected,
      ),
    ).toBeUndefined();
  });

  it("recovers one trailing partial append and deterministically materializes evidence", () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-attempt-journal-"));
    try {
      const entry = {
        raw: { run_id: "run-1", recorder_events: [], calls: [] },
        run: { run_id: "run-1", outcome: "setup-error" },
      } as unknown as AttemptJournalEntry;
      fs.writeFileSync(
        path.join(output, "attempt-journal.jsonl"),
        `${JSON.stringify(entry)}\n{"raw":`,
      );

      const recovered = recoverAttemptJournal(output);
      expect(recovered).toEqual([entry]);
      expect(fs.readFileSync(path.join(output, "attempt-journal.jsonl"), "utf8")).toBe(
        `${JSON.stringify(entry)}\n`,
      );

      materializeAttemptJournal(output, recovered);
      expect(JSON.parse(fs.readFileSync(path.join(output, "raw-events.jsonl"), "utf8"))).toEqual(
        entry.raw,
      );
      expect(JSON.parse(fs.readFileSync(path.join(output, "runs.jsonl"), "utf8"))).toEqual(
        entry.run,
      );
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("fails closed for a newline-terminated malformed journal record", () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-attempt-journal-"));
    try {
      const file = path.join(output, "attempt-journal.jsonl");
      const malformed = '{"raw":\n';
      fs.writeFileSync(file, malformed);

      expect(() => recoverAttemptJournal(output)).toThrow(/corrupt at line 1/u);
      expect(fs.readFileSync(file, "utf8")).toBe(malformed);
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("requires two fresh campaigns with identical frozen inference configuration", () => {
    const { manifest, attestations } = attestationFixture();
    expect(() => validateCampaignAttestations(manifest, attestations)).not.toThrow();

    const reusedContainer = structuredClone(attestations);
    reusedContainer[1].inference_container_id_sha256 =
      reusedContainer[0].inference_container_id_sha256;
    expect(() => validateCampaignAttestations(manifest, reusedContainer)).toThrow(
      /distinct vLLM containers/u,
    );

    const changedConfiguration = structuredClone(attestations);
    changedConfiguration[1].inference_config_sha256 = hex(101);
    expect(() => validateCampaignAttestations(manifest, changedConfiguration)).toThrow(
      /identical frozen config/u,
    );

    const reusedSandbox = structuredClone(attestations);
    reusedSandbox[1].sandbox_cells[0].instance_id_sha256 =
      reusedSandbox[0].sandbox_cells[0].instance_id_sha256;
    expect(() => validateCampaignAttestations(manifest, reusedSandbox)).toThrow(
      /reused or omitted sandbox instances/u,
    );
  });
});
