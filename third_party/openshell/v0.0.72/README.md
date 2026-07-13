<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# OpenShell gRPC protocol pin

This directory contains exact copies of the public protocol sources from
NVIDIA OpenShell tag `v0.0.72` at commit
`8cb16de9eae4c44d7d31e1493747d8c10abb5963`.

NemoClaw keeps these sources private to its OpenShell adapter. They provide the
wire contract for the direct gRPC migration and can be replaced by the official
TypeScript SDK without changing callers of that adapter.

The repository dependency check binds this directory to
`nemoclaw-blueprint/blueprint.yaml` and verifies the SHA-256 digest of every
protocol file. Update the version, sources, and digests together when NemoClaw
changes its supported OpenShell version.
