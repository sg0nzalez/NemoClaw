// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "src", "lib", "adapters", "openshell", "proto");
const dest = path.join(root, "dist", "lib", "adapters", "openshell", "proto");

fs.mkdirSync(dest, { recursive: true });
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".proto")) continue;
  fs.copyFileSync(path.join(source, entry.name), path.join(dest, entry.name));
}
