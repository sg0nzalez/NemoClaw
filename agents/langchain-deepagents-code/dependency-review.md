<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `d8b01f36a0f325f38d18b4dc2cfdf452125987571a86ca58d9c93e08b7b06a14`
- Audit command: `uv tool run --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off --disable-pip`
- Audit date: 2026-07-07
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.

## Released Nemotron 3 Ultra Profile

Deep Agents Code `0.1.34` pins `deepagents==0.7.0a6`, whose official wheel
contains the Nemotron 3 Ultra harness profile merged in Deep Agents PR #4192.
NemoClaw no longer vendors or overlays that source.

- Native profile SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- Unmodified built-in bootstrap SHA-256: `005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf`
- First-party adapter: `nemoclaw-deepagents-profile==0.1.0`
- Adapter module SHA-256: `d5e2e8214e46fd61265d2377a3f9a30d827f19f08fc50272980b69fda3669fc1`
- Adapter project metadata SHA-256: `7ba7b77bd6f889cc861eddbe3e38fc1f4433a85b7bc2a9b516e19a19a37a7686`
- Adapter dependency audit result: `No known vulnerabilities found`. Its only
  requirements are the exact `deepagents-code==0.1.34` and
  `deepagents==0.7.0a6` entries covered by the lockfile audit command above; no
  additional third-party distribution is introduced.

Before local build and installation, the managed image verifies both copied
adapter build inputs against the module and project-metadata hashes recorded
above. It then installs the first-party `nemoclaw-deepagents-profile` package
without consulting an index. Its `deepagents.harness_profiles` entry
point runs after built-in profiles are registered, reads the reviewed canonical
profile through one exact-version/hash-gated private registry lookup, and uses
Deep Agents' public registration API to map it to the two exact `openai:` model
keys used by NemoClaw's managed OpenAI-compatible `ChatOpenAI` route. The
released SDK has no public profile getter or alias API. The adapter does not add
a provider-wide OpenAI profile.

The adapter verifies the exact DCode and Deep Agents versions plus the official
native-profile and bootstrap source hashes. It also binds the imported Deep
Agents package to the distribution that supplied the reviewed version.
Registration is atomic, idempotent, and rejects missing canonical, partial, or
conflicting alias state. The image validator runs under isolated Python,
verifies the installed entry-point metadata and adapter source hash before the
upstream source checks, checks both upstream files again after profile loading,
resolves the complete native middleware for both aliases, compiles a graph,
proves parser/native dispatch parity, and confirms an unrelated OpenAI model
receives no Ultra behavior. The Docker build separately imports the adapter,
Deep Agents, and DCode under isolated Python immediately after installation;
the validator then binds the installed module to its distribution and rechecks
the module hash. A DCode-only CI regression builds the current, hash-locked
`Dockerfile.base` instead of consuming a mutable registry tag, strips both
upstream distributions, and proves the production build stops at that import
gate before the later dependency-consistency check.

The reviewed native-profile and bootstrap files stay byte-for-byte unchanged.
Focused fixtures cover the reviewed version/hash, missing-source,
missing-canonical, partial/conflicting, rollback, and idempotence states. The
deleted source-backport license path, `LICENSE.langchain-deepagents`, is not
staged into the image, and image regression tests enforce that absence.

Deep Agents Code `0.1.34` is the released consumer; prerelease risk is limited
to its exact `deepagents==0.7.0a6` SDK pin. That risk is accepted because the
consumer and SDK are hash locked, the dependency audit is clean, and all source,
version, middleware, graph, and dispatch contracts are enforced by the isolated
image-build validator. That validator is the fail-closed gate because Deep
Agents deliberately isolates and logs third-party plugin callback failures.

The exact version and source-hash gates remain the executable lifecycle check
for the alias adapter: any dependency change stops the image build and requires
this review to revalidate the managed adapter. Remove it instead of refreshing
its hashes only if a future reviewed dependency already provides both exact
mappings; no external contribution is required. Issue #6424 records the
NemoClaw-owned replacement of the previous installed-bootstrap mutation.
