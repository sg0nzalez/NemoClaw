---
name: nemoclaw-maintainer-validate-launchable-e2e
description: "Validates a NemoClaw release candidate through the cross-repository pre-tag Brev Launchable staging gate without implementing the automation. Use when maintainers need to audit current E2E coverage, verify a nemoclaw-image receipt and GCP boot-image provenance, run an organization-only staging Launchable smoke/E2E, classify failures and timing, report the exact-SHA gate verdict, or clean up a qualification attempt. Trigger keywords - Launchable E2E, pre-tag gate, staging image, image receipt, GCP image family, boot provenance, release candidate validation."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate Launchable E2E

Validate one frozen NemoClaw commit across `NVIDIA/NemoClaw`, `brevdev/nemoclaw-image`, and Brev Launchables. Treat this as a maintainer validation and gating runbook, not as the automation itself.

## Ownership Boundary

| Owner | Responsibility |
| --- | --- |
| `NVIDIA/NemoClaw` | Freeze the candidate, audit the canonical E2E set, consume the image receipt, run Launchable behavior checks, publish the verdict, and verify cleanup. |
| `brevdev/nemoclaw-image` | Resolve and build the exact candidate, emit the versioned immutable-image receipt, and own image readiness, retention, and build diagnostics. |
| Brev | Provide supported Launchable create or revise, deploy, readiness, and delete operations with structured identities, plus immutable boot-image readback or an owner-approved GCP verification path. |

## Hard Rules

- Operate only on a dedicated organization-only staging Launchable and its workspaces. Never mutate a production Launchable, production image family or channel, `lkg`, `latest`, semver tags, or the post-tag production-image workflow.
- Key every request, artifact, and verdict to the full 40-character `origin/main` candidate SHA. If the candidate changes, discard the attempt and start again with approval for the new SHA.
- Treat the exact GCP image name, numeric image ID, and image self-link as provenance. A mutable family may select an image, but it is never final provenance or a passing-gate substitute. Guest metadata that returns only the image name is corroboration, not complete immutable evidence.
- Keep this workflow GCP-specific. A maintainer-observed GCP family pass-through has been live-tested; AWS image selection, AMI pinning, boot provenance, and cleanup have not. Do not infer AWS behavior from GCP evidence.
- Use only a released, Brev-supported interface. Never call private or unfinished endpoints, bind to private browser request or SSE schemas, scrape credentials, or copy a human access or refresh token into an agent, command, artifact, or CI secret.
- For a manual shadow run, let the maintainer authenticate through a supported human interface without transferring the token. Require a Brev-supported non-interactive CI identity, create or revise and delete contract, and approved immutable boot-image readback before production or blocking release automation.
- Run trusted workflow code from a trusted ref. Pass the candidate SHA as data; never select candidate-controlled workflow code.
- Obtain protected maintainer approval immediately before the first billable action. One approval authorizes one SHA, one correlation ID, at most one image build, and at most one workspace. Do not retry mutations without new approval.
- Never substitute source rsync, a source overlay, or a generic startup script for booting the received image.
- Register cleanup before the first mutation. Run it after success, failure, cancellation, or supersession. Treat incomplete cleanup as failing.

## Progress Checklist

```text
Launchable gate progress:
- [ ] Freeze the candidate and audit current E2E coverage
- [ ] Verify the image build run and immutable-image receipt
- [ ] Record the GCP selection and immutable boot identity
- [ ] Create the organization-only staging Launchable workspace
- [ ] Prove the boot image and run the smoke/E2E assertions
- [ ] Classify the result and assemble the exact-SHA gate report
- [ ] Clean up every attempted mutation and verify absence or restoration
```

## 1. Freeze and Audit

Record the full candidate SHA selected under the maintainer-approved soft merge freeze. Record whether the attempt is `shadow` or `release`. Default to `shadow` until the real Launchable lane is declared by the candidate's `.github/workflows/e2e.yaml` and maintainers accept blocking rollout. Before declaring a release-mode result eligible, require the candidate to equal the SHA frozen by the release plan.

Read `.github/workflows/e2e.yaml` at that SHA. It is the sole source of truth for the pre-tag E2E ledger; follow the canonical [pre-tag E2E evidence policy](../nemoclaw-maintainer-policies/references/release-train.md#pre-tag-e2e-evidence). Expand matrix executions separately and treat skipped, pending, cancelled, and failing executions as non-passing.

Re-audit the live repository instead of copying the historical matrix from #6943. At minimum, distinguish:

- the source-based `launchable-smoke` on a generic GitHub runner;
- Brev branch validation that boots a generic workspace and overlays source;
- the image repository's GCP build, readiness, and family-publication checks;
- any declared but unwired Launchable target; and
- the missing or present boundary that boots the received image on a real Launchable and uses public onboarding.

Record the full audited NemoClaw and image-repository SHAs, then produce this matrix for every important Launchable user journey:

| Journey | Repository and lane | Mocked or live | Ordinary E2E, branch validation, or none | Owner | What it proves | Gap |
| --- | --- | --- | --- | --- | --- | --- |

Mark each journey required or optional for this attempt using an accepted maintainer decision. In release mode, return `BLOCKED` when no accepted real-Launchable selection is declared by the candidate workflow. A shadow run may use an explicitly approved provisional selection, but it is not release-unblocking evidence. Adjacent component coverage is not a Launchable gate result.

## 2. Verify the Image Receipt

Before protected approval or dispatch, complete every non-billable preflight:

- confirm that the producer owner accepted the versioned receipt schema and transport and that trusted `brevdev/nemoclaw-image` workflow code implements them;
- confirm a supported Brev identity and interface can create or revise, read, deploy, and delete with structured Launchable and workspace identities;
- confirm a Brev-supported or owner-approved GCP path can read the immutable numeric boot image ID;
- confirm the intended target and supported visibility readback are organization-only;
- confirm the accepted required-journey selection, cleanup plan, cost ceiling, and attempt timeout; and
- register every cleanup action before its corresponding mutation.

A draft or ad hoc artifact is not a contract. If any preflight is missing, return `BLOCKED` without starting the image build or other billable work.

Correlate the dispatch to one trusted `brevdev/nemoclaw-image` workflow run and attempt. Download only that run's deterministic artifact; never select the newest matching artifact globally.

For the v1 handoff, require artifact `nemoclaw-image-handoff-v1-<run-id>-<attempt>` to contain exactly one regular UTF-8 file named `nemoclaw-image-manifest.v1.json`, no symlinks or traversal paths, and no more than 64 KiB. Verify available artifact digest or attestation, hash the accepted bytes, and retain the hash in the gate evidence. Once an approved producer run starts, a missing or invalid receipt is `FAIL`; never reconstruct one from logs.

Validate the strict receipt and its semantics, including:

- requester and producer repositories, workflows, run IDs, attempts, event, trusted head SHA, and correlation ID;
- full lowercase NemoClaw and image-repository SHAs;
- `channel=staging` and the currently accepted `variant=cpu`;
- built or reused origin run and attempt, creation time, manifest time, and accepted reuse age;
- exact GCP project, image name, decimal-string numeric image ID, image self-link, and `READY` status; and
- observed family as publication metadata only.

Reject missing or extra fields, a family self-link, a short SHA, wrong run identity, unsafe artifact contents, non-`READY` status, digest mismatch, or any semantic provenance mismatch. Re-describe the exact image immediately before provisioning and require the same name, numeric ID, self-link, labels, and status recorded by the receipt.

## 3. Resolve the GCP Selection

Prefer passing the exact image self-link when the supported interface accepts it. For the live-tested GCP family path, pass the family only through a supported Launchable image selector. GCP resolves the latest non-deprecated family member while creating the boot disk. Treat a preflight family lookup as an expected value only because the family can move before disk creation.

After workspace creation, obtain the boot disk's immutable `sourceImageId` through a Brev-supported readback or an owner-approved GCP verification path. Also record the exact image name and self-link. Guest metadata can corroborate the exact image name but does not supply the numeric ID.

Before mutation, confirm that an approved readback can establish the numeric boot image ID; otherwise return `BLOCKED`. After mutation, inability to obtain the ID is `FAIL`. Treat a missing ID, same-name replacement, or any receipt mismatch as `BREV_IMAGE_RESOLUTION_MISMATCH` and `FAIL`.

Use this verified 2026-07-15 observation only as an example of GCP family pass-through, never as current configuration or sufficient provenance:

```text
family: projects/brevdevprod/global/images/family/nemoclaw-brev-staging-cpu
boot image: projects/brevdevprod/global/images/nemoclaw-brev-cpu-v0-1-0-20260715-c437dec84-staging-187-1
```

The maintainer-observed boot proves GCP family pass-through for that test only. Public image workflow run `29432813736`, attempt `1`, proves the same staging image reached `READY` and was published to the family, but it contains no Launchable boot job. Neither fact alone proves the numeric boot ID, a completed E2E gate, or verified cleanup. Do not create an AWS path until AWS has its own supported interface and live immutable-provenance validation.

## 4. Run the Organization-Only Staging Launchable

Before mutation, record the approved staging organization, Launchable identity, previous revision, intended revision, intended organization-only visibility, machine and storage request, estimated hourly and maximum attempt cost, hard timeout, and cleanup action. Preflight the supported create, readback, and delete operations. Return `BLOCKED` if any required operation is unavailable or any target could be production or externally visible.

Through the supported Brev interface:

1. Create or revise only the dedicated staging Launchable and record the immutable revision identity.
2. Re-read the Launchable visibility and organization ACL. If it is public or externally visible, stop, clean up the mutation, and return `FAIL`.
3. Deploy one workspace and record its immutable identity.
4. Wait for structured readiness within the attempt timeout.
5. Prove the actual boot image matches the accepted receipt through supported Brev readback or the approved GCP verification path before behavioral assertions.

If a preflight cannot establish structured revision and workspace identities, deletion by workspace identity, or approved immutable boot-image readback, report `BLOCKED` and stop. If one of those operations fails after mutation, return `FAIL` and continue cleanup. Do not use a private endpoint or human token to finish the attempt.

Drive the currently accepted public onboarding journey as a black box. Use the customer-facing browser `/onboard` path until the agent-driven flow is accepted as the canonical Brev boundary, then prefer that shared path. Select OpenClaw and the approved provider and model, and supply credentials only through the supported interface. Do not couple the gate to private `/api/onboard` or SSE contracts.

Use the accepted required and optional selection from the coverage audit, then reuse the candidate's canonical assertions instead of creating a second behavior list. The initial smoke should require at least:

- browser and UI readiness;
- onboarding completion and expected registry, policy, credential-boundary, and provider-routing state;
- real hosted and sandbox inference where declared by the canonical lane;
- a successful OpenClaw agent response;
- exactly one gateway listener with its declared lifecycle owner; and
- zero skipped or pending required assertions.

Retain only redacted evidence. Never store form credentials, cookies, tokens, raw environment dumps, or unredacted browser traces.

## 5. Classify Failure and Timing

Record `failedStage`, `gateCategory`, and, when supplied by the image contract, `failureClass` and `failureCode`. Use stages such as image dispatch, receipt, family resolution, Launchable revision, workspace boot, boot provenance, onboarding, E2E assertion, and cleanup.

Classify the maintainer-facing gate outcome consistently:

| Gate category | Meaning |
| --- | --- |
| `build` | The exact image did not build or reach `READY`. |
| `capacity` | Required GCP or Brev capacity or quota was unavailable. |
| `launch` | Launchable revision, workspace creation, or readiness failed. |
| `provenance` | Receipt, family resolution, or actual boot identity disagreed. |
| `test` | Public onboarding or a required E2E assertion failed. |
| `cleanup` | Deletion, absence, or restoration could not be verified. |
| `timeout` | A queue, build, launch, test, or total attempt deadline expired. |
| `retry-exhausted` | A permitted read-only retry budget ended without success. |
| `authorization` | Approval or supported identity was missing or rejected. |
| `interface` | A required supported interface or immutable readback contract was unavailable. |
| `cancelled` | The attempt was cancelled or superseded. |
| `unknown` | Evidence cannot support a more specific category. |

Use the stable classes and codes from #6943 where applicable:

| Class | Representative codes |
| --- | --- |
| `request` | `REQUEST_INVALID`, `UNSUPPORTED_VARIANT` |
| `authorization` | `DISPATCH_FORBIDDEN` |
| `build` | `SOURCE_RESOLUTION_FAILED`, `PRODUCER_CONFIG_ERROR`, `BUILD_FAILED` |
| `readiness` | `IMAGE_NOT_READY` |
| `handoff` | `ARTIFACT_MISSING_OR_INVALID`, `PROVENANCE_MISMATCH`, `IMAGE_IDENTITY_MISMATCH`, `BREV_IMAGE_RESOLUTION_MISMATCH` |
| `timeout` | `RUN_QUEUE_TIMEOUT`, `QUALIFICATION_TIMEOUT` |
| `cancelled` | `CANCELLED`, `SUPERSEDED` |
| `unknown` | `UNKNOWN` |

Preserve the primary failure when cleanup also fails, and report cleanup as a second failing outcome. Retry only read-only polling, same-run lookup, artifact download, and metadata reads within the deadline. Discover an ambiguous dispatch by correlation; never blindly dispatch again. Never automatically retry an image build, Launchable revision, or workspace creation.

Recent successful manually dispatched staging builds were observed at roughly 17–26 minutes. Re-measure rather than treating that range as a promise. Use one image-handoff clock:

- 10 minutes from dispatch for the queue or start sub-deadline;
- 25 minutes for an operational warning;
- 45 minutes for the hard handoff deadline, including queue and artifact propagation;
- polling from 15 seconds up to 60 seconds with jitter and `Retry-After`; and
- at most two minutes of same-run artifact-propagation retries inside the 45-minute deadline.

Start qualification early enough that the tagger consumes a completed result instead of initiating the build. Treat the initial 60-minute pre-cutoff lead as an advisory buffer, not an SLO. Separately record image, family resolution, Launchable revision, workspace ready, UI ready, onboard-to-sandbox-ready, inference, agent response, and cleanup durations. Do not invent a total Launchable E2E SLO before the shadow data is reviewed.

## 6. Clean Up Completely

Run registered cleanup in reverse mutation order without masking the primary result:

1. Verify the producer run removed its temporary builder VM, disks, firewall rules, and other ephemeral build resources. Preserve the qualified staging image.
2. Tear down the NemoClaw sandbox and gateway resources created by the attempt.
3. Delete the workspace by immutable identity and poll a supported structured read or list operation until it is absent.
4. Delete every ephemeral staging Launchable or revision created by the attempt and verify absence. If the attempt revised a pre-existing dedicated staging Launchable, restore its recorded prior revision and verify the restoration instead.
5. Remove local temporary credential, cookie, and raw-artifact material after retaining the approved redacted evidence.

Do not delete the exact staging image during cleanup. Keep it through the qualification hold and the retention period accepted for the attempt; #6943 proposes at least 72 hours after the terminal verdict. If cleanup cannot prove absence or restoration, report every surviving immutable identity and escalate the leak. The attempt is `FAIL`.

## 7. Report the Gate

Publish one redacted report keyed to the candidate SHA:

```text
Launchable E2E Gate:
- mode: shadow or release; release eligibility
- candidate SHA and release-plan match
- controller workflow run and attempt; correlation ID
- image producer and origin runs, image-repository SHA, receipt digest
- observed family plus exact image project, name, numeric ID, and self-link
- staging organization and visibility; Launchable revision and workspace identity
- required E2E ledger entries with run/job URLs and attempts
- per-stage timings; cost estimate and observed cost
- retry counts and exhausted budget, if any
- failed stage, gate category, failure class, and code when non-passing
- cleanup actions and verified final state
- verdict: PASS, FAIL, or BLOCKED
```

Return `PASS` only when the receipt and boot provenance match, every required assertion passes, evidence is redacted, and cleanup is verified. A manual shadow `PASS` records evidence but cannot unblock tagging. Set release eligibility only for a release-mode `PASS` whose candidate exactly matches the release-plan SHA after the real Launchable lane is declared by the candidate workflow and blocking rollout is accepted. Return `FAIL` when an approved attempt runs but build, capacity, launch, provenance, test, timeout, retry, or cleanup requirements fail. Return `BLOCKED` when approval, producer contract acceptance, the implemented versioned receipt, a supported interface or identity, accepted required-journey selection, or approved immutable readback is unavailable before mutation. No other result may unblock tagging.

For a declared release-mode lane, attach the result to the canonical `.github/workflows/e2e.yaml` evidence ledger; do not create a separate release-gating list. Retain shadow reports as supplemental correlated evidence outside that ledger and never treat them as release-unblocking. Leave itemized maintainer exceptions to the existing release policy. State explicitly that staging qualification does not prove bit-for-bit identity with the separately built production image.
