// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const OLLAMA_AUTH_PROXY_SCRIPT_PATTERN = /(?:^|[\s/\\])ollama-auth-proxy\.(?:js|mts)(?=$|\s)/;

export function isOllamaAuthProxyCommandLine(commandLine: string): boolean {
  return OLLAMA_AUTH_PROXY_SCRIPT_PATTERN.test(commandLine);
}
