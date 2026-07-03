// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Type } from "typebox";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type OpenClawPluginApi = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
  }): void;
};

const WeatherParameters = Type.Object(
  {
    location: Type.String({ description: "City or place name." }),
  },
  { additionalProperties: false },
);

const plugin = {
  id: "weather",
  name: "NemoClaw E2E Weather",
  description: "Registers a deterministic weather tool for custom-image lifecycle tests.",
  register(api: OpenClawPluginApi): void {
    api.registerTool({
      name: "get_weather",
      label: "Get Weather",
      description: "Return deterministic weather data for a location.",
      parameters: WeatherParameters,
      async execute(_toolCallId, params) {
        const location = typeof params.location === "string" ? params.location : "unknown";
        const details = { location, condition: "clear", temperatureC: 21 };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      },
    });
  },
};

export default plugin;
