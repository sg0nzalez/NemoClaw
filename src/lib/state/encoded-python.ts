// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../runner.js";

const PYTHON_BASE64_BOOTLOADER =
  "import base64,sys;exec(compile(base64.b64decode(sys.argv.pop(1)), '<nemoclaw-state-python>', 'exec'))";

/** Render multiline Python without placing control characters in an OpenShell exec argument. */
export function buildEncodedPythonInvocation(
  interpreter: string,
  program: string,
  isolated = false,
): string {
  const encodedProgram = Buffer.from(program, "utf8").toString("base64");
  return [
    interpreter,
    ...(isolated ? ["-I"] : []),
    "-c",
    shellQuote(PYTHON_BASE64_BOOTLOADER),
    shellQuote(encodedProgram),
  ].join(" ");
}
