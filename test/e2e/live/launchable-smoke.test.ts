// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The trusted PR E2E workflow on main can still select this previous filename
// while the job rename is under review. Keep that exact-head dispatch executable
// without collecting the bootstrap test twice through the new workflow.
await (process.env.E2E_TARGET_ID === "launchable-smoke"
  ? import("./bootstrap-install-smoke.test.ts")
  : Promise.resolve());
