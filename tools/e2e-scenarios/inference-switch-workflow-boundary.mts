// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-vitest-scenarios.yaml");

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string[] | string;
  steps?: WorkflowStep[];
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: Array<Record<string, unknown>> };
  };
  "runs-on"?: string;
  "timeout-minutes"?: number;
};

export type InferenceSwitchWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

type JobSpec = {
  agent: "hermes" | "openclaw";
  artifactRoot: string;
  jobName: string;
  runStepName: string;
  scenario: string;
  testFile: string;
  timeoutMinutes: number;
  uploadStepName: string;
};

const JOB_SPECS: JobSpec[] = [
  {
    agent: "hermes",
    artifactRoot: "hermes-inference-switch",
    jobName: "hermes-inference-switch-vitest",
    runStepName: "Run Hermes inference switch live Vitest test",
    scenario: "hermes-inference-switch",
    testFile: "test/e2e-scenario/live/hermes-inference-switch.test.ts",
    timeoutMinutes: 55,
    uploadStepName: "Upload Hermes inference switch artifacts",
  },
  {
    agent: "openclaw",
    artifactRoot: "openclaw-inference-switch",
    jobName: "openclaw-inference-switch-vitest",
    runStepName: "Run OpenClaw inference switch live test",
    scenario: "openclaw-inference-switch",
    testFile: "test/e2e-scenario/live/openclaw-inference-switch.test.ts",
    timeoutMinutes: 90,
    uploadStepName: "Upload OpenClaw inference switch artifacts",
  },
];

const COMMON_SECRET_ENV_NAMES = [
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
  "DOCKERHUB_USERNAME",
  "DOCKERHUB_TOKEN",
  "GITHUB_TOKEN",
];

export function readInferenceSwitchWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): InferenceSwitchWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as InferenceSwitchWorkflow;
}

function expectedMatrix(agent: JobSpec["agent"]): Array<Record<string, unknown>> {
  return [
    {
      mode: "hosted",
      sandbox_name: `e2e-${agent}-inference-switch`,
      switch_provider: "compatible-endpoint",
      switch_model: "nvidia/nvidia/nemotron-3-super-v3",
      switch_inference_api: "openai-completions",
      switch_mock_anthropic: "0",
    },
    {
      mode: "anthropic",
      sandbox_name: `e2e-${agent}-anthropic-inference-switch`,
      switch_provider: "compatible-anthropic-endpoint",
      switch_model: "mock-anthropic-model",
      switch_inference_api: "anthropic-messages",
      switch_mock_anthropic: "1",
    },
  ];
}

function expectedSelector(spec: JobSpec): string {
  return `\${{ (inputs.jobs == '' && inputs.scenarios == '') || contains(format(',{0},', inputs.jobs), ',${spec.jobName},') || contains(format(',{0},', inputs.scenarios), ',${spec.scenario},') }}`;
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

function stepIndex(job: WorkflowJob, name: string): number {
  return job.steps?.findIndex((step) => step.name === name) ?? -1;
}

function requireEqual(errors: string[], actual: unknown, expected: unknown, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) errors.push(message);
}

function requireRunContains(
  errors: string[],
  jobName: string,
  step: WorkflowStep,
  fragment: string,
): void {
  if (!step.run?.includes(fragment)) {
    errors.push(`${jobName} step ${step.name ?? "<missing>"} must contain: ${fragment}`);
  }
}

function validatePinnedActions(errors: string[], spec: JobSpec, job: WorkflowJob): void {
  for (const step of job.steps ?? []) {
    if (step.uses && !/^[^@]+@[0-9a-f]{40}$/u.test(step.uses)) {
      errors.push(`${spec.jobName} action ${step.uses} must pin a full commit SHA`);
    }
  }

  const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (!checkout) {
    errors.push(`${spec.jobName} must check out the repository`);
  } else if (checkout.with?.["persist-credentials"] !== false) {
    errors.push(`${spec.jobName} checkout must disable persisted credentials`);
  }
}

function validateStepSecretScope(errors: string[], spec: JobSpec, job: WorkflowJob): void {
  const allowed = new Set([`${spec.runStepName}:NVIDIA_INFERENCE_API_KEY`]);
  if (spec.agent === "openclaw") {
    allowed.add("Authenticate to Docker Hub:DOCKERHUB_USERNAME");
    allowed.add("Authenticate to Docker Hub:DOCKERHUB_TOKEN");
  }

  for (const step of job.steps ?? []) {
    for (const [name, value] of Object.entries(step.env ?? {})) {
      if (
        typeof value === "string" &&
        value.includes("${{ secrets.") &&
        !allowed.has(`${step.name}:${name}`)
      ) {
        errors.push(`${spec.jobName} must not expose ${name} to step ${step.name ?? "<unnamed>"}`);
      }
    }
  }
}

function validateCommonJob(errors: string[], spec: JobSpec, job: WorkflowJob): void {
  const env = job.env ?? {};
  requireEqual(
    errors,
    job.needs,
    "generate-matrix",
    `${spec.jobName} must depend on generate-matrix`,
  );
  requireEqual(
    errors,
    job.if,
    expectedSelector(spec),
    `${spec.jobName} must remain default-enabled and selectable`,
  );
  requireEqual(
    errors,
    job["runs-on"],
    "ubuntu-latest",
    `${spec.jobName} must run on ubuntu-latest`,
  );
  requireEqual(
    errors,
    job["timeout-minutes"],
    spec.timeoutMinutes,
    `${spec.jobName} timeout must remain ${spec.timeoutMinutes} minutes`,
  );
  requireEqual(
    errors,
    job.strategy?.["fail-fast"],
    false,
    `${spec.jobName} matrix must not fail fast`,
  );
  requireEqual(
    errors,
    job.strategy?.matrix?.include,
    expectedMatrix(spec.agent),
    `${spec.jobName} must run the exact hosted and Anthropic-compatible mode matrix`,
  );

  const expectedEnv: Record<string, unknown> = {
    FREE_STANDING_VITEST_JOB: "1",
    FREE_STANDING_SCENARIO_ID: spec.scenario,
    E2E_ARTIFACT_DIR: `\${{ github.workspace }}/e2e-artifacts/vitest/${spec.artifactRoot}/\${{ matrix.mode }}`,
    NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
    NEMOCLAW_RUN_E2E_SCENARIOS: "1",
    NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: spec.agent,
    NEMOCLAW_SANDBOX_NAME: "${{ matrix.sandbox_name }}",
    NEMOCLAW_SWITCH_PROVIDER: "${{ matrix.switch_provider }}",
    NEMOCLAW_SWITCH_MODEL: "${{ matrix.switch_model }}",
    NEMOCLAW_SWITCH_INFERENCE_API: "${{ matrix.switch_inference_api }}",
    NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "${{ matrix.switch_mock_anthropic }}",
    OPENSHELL_GATEWAY: "nemoclaw",
  };
  requireEqual(errors, env, expectedEnv, `${spec.jobName} environment contract must not drift`);

  for (const secretName of COMMON_SECRET_ENV_NAMES) {
    if (Object.hasOwn(env, secretName)) {
      errors.push(`${spec.jobName} must not expose ${secretName} at job scope`);
    }
  }

  validatePinnedActions(errors, spec, job);
  validateStepSecretScope(errors, spec, job);

  const run = findStep(job, spec.runStepName);
  requireEqual(
    errors,
    run.env?.NVIDIA_INFERENCE_API_KEY,
    "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    `${spec.jobName} must expose the inference key only to its live test step`,
  );
  requireRunContains(errors, spec.jobName, run, "npx vitest run --project e2e-scenarios-live");
  requireRunContains(errors, spec.jobName, run, spec.testFile);

  const upload = findStep(job, spec.uploadStepName);
  requireEqual(errors, upload.if, "always()", `${spec.jobName} artifact upload must always run`);
  requireEqual(
    errors,
    upload.with?.name,
    `e2e-vitest-scenarios-${spec.artifactRoot}-\${{ matrix.mode }}`,
    `${spec.jobName} artifact name must identify its matrix mode`,
  );
  if (
    !String(upload.with?.path ?? "").includes(
      `e2e-artifacts/vitest/${spec.artifactRoot}/\${{ matrix.mode }}/`,
    )
  ) {
    errors.push(`${spec.jobName} artifact path must identify its matrix mode`);
  }
  requireEqual(
    errors,
    upload.with?.["include-hidden-files"],
    false,
    `${spec.jobName} artifact upload must exclude hidden files`,
  );
  requireEqual(
    errors,
    upload.with?.["if-no-files-found"],
    "ignore",
    `${spec.jobName} artifact upload must tolerate missing failure artifacts`,
  );
  requireEqual(
    errors,
    upload.with?.["retention-days"],
    14,
    `${spec.jobName} artifact retention must remain 14 days`,
  );
}

function validateHermesSecretBoundary(errors: string[], job: WorkflowJob): void {
  const jobName = "hermes-inference-switch-vitest";
  const install = findStep(job, "Install OpenShell CLI");
  for (const secretName of COMMON_SECRET_ENV_NAMES) {
    requireRunContains(errors, jobName, install, `-u ${secretName}`);
  }
  requireRunContains(errors, jobName, install, "bash scripts/install-openshell.sh");
  if (
    stepIndex(job, "Install OpenShell CLI") >=
    stepIndex(job, "Run Hermes inference switch live Vitest test")
  ) {
    errors.push(`${jobName} must install OpenShell before secrets enter the live test step`);
  }
}

function validateOpenClawDockerBoundary(errors: string[], job: WorkflowJob): void {
  const jobName = "openclaw-inference-switch-vitest";
  const configureName = "Configure isolated Docker auth directory";
  const authName = "Authenticate to Docker Hub";
  const runName = "Run OpenClaw inference switch live test";
  const configure = findStep(job, configureName);
  requireRunContains(
    errors,
    jobName,
    configure,
    "${RUNNER_TEMP}/docker-config-openclaw-inference-switch-${{ matrix.mode }}",
  );
  requireRunContains(errors, jobName, configure, 'chmod 700 "${docker_config}"');
  requireRunContains(errors, jobName, configure, '>> "${GITHUB_ENV}"');

  const auth = findStep(job, authName);
  requireEqual(
    errors,
    auth.env,
    {
      DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    },
    `${jobName} must expose Docker credentials only to its login step`,
  );
  requireRunContains(errors, jobName, auth, "docker login docker.io");

  const configureIndex = stepIndex(job, configureName);
  const authIndex = stepIndex(job, authName);
  const runIndex = stepIndex(job, runName);
  if (configureIndex < 0 || authIndex <= configureIndex || runIndex <= authIndex) {
    errors.push(`${jobName} must configure auth, log in, then run the live test in that order`);
  }

  const cleanup = findStep(job, "Clean up Docker auth");
  requireEqual(errors, cleanup.if, "always()", `${jobName} Docker auth cleanup must always run`);
  requireRunContains(
    errors,
    jobName,
    cleanup,
    "${DOCKER_CONFIG:-${RUNNER_TEMP}/docker-config-openclaw-inference-switch-${{ matrix.mode }}}",
  );
  requireRunContains(errors, jobName, cleanup, "docker logout docker.io");
  requireRunContains(errors, jobName, cleanup, 'rm -rf "${docker_config}"');
}

export function validateInferenceSwitchWorkflow(workflow: InferenceSwitchWorkflow): string[] {
  const errors: string[] = [];

  for (const spec of JOB_SPECS) {
    const job = workflow.jobs[spec.jobName] ?? {};
    validateCommonJob(errors, spec, job);
    if (spec.agent === "hermes") validateHermesSecretBoundary(errors, job);
    else validateOpenClawDockerBoundary(errors, job);
  }

  const reportNeeds = workflow.jobs["report-to-pr"]?.needs;
  for (const spec of JOB_SPECS) {
    if (!Array.isArray(reportNeeds) || !reportNeeds.includes(spec.jobName)) {
      errors.push(`report-to-pr must wait for ${spec.jobName}`);
    }
  }

  return errors;
}

export function validateInferenceSwitchWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateInferenceSwitchWorkflow(readInferenceSwitchWorkflow(workflowPath));
}
