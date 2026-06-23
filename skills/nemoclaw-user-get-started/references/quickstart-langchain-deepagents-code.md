# Quickstart with LangChain Deep Agents Code

Use this guide when you want NemoClaw to build an OpenShell sandbox with the `dcode` terminal coding agent installed and configured for NemoClaw-managed inference.

## Onboard

Run onboarding with the canonical agent ID.

```bash
nemoclaw onboard --agent langchain-deepagents-code
```

The image installs a hash-locked, pinned Deep Agents Code release with NVIDIA provider support.
NemoClaw writes `/sandbox/.deepagents/config.toml` with an OpenAI-compatible provider pointed at `https://inference.local/v1`, uses a scoped placeholder API key for that managed route, and sets `use_responses_api = false` for Chat Completions compatibility.
NemoClaw/OpenShell keeps real provider credentials in credential handling and does not write them into the Deep Agents config file.

## Use the Harness

Connect to the sandbox, then launch the terminal UI.

```bash
nemoclaw <sandbox-name> connect
dcode
```

For a single headless task, run:

```bash
dcode -n "Summarize this repository"
```

The managed wrapper launches Deep Agents Code with `HOME=/sandbox`, update checks disabled, remote Deep Agents sandbox providers disabled, MCP auto-loading disabled, and shell allow-list overrides blocked.

## State and Backup

Deep Agents Code state lives under `/sandbox/.deepagents`.
NemoClaw snapshot and rebuild flows preserve the app state directory, skills, generated config, and hooks config when those files exist.
NemoClaw intentionally does not preserve `.env` or `.mcp.json` because users may put Tavily, LangSmith, MCP service, or provider credentials there, and this managed harness disables MCP at runtime.

## Optional Web Search

Deep Agents Code can use Tavily web search when you provide a Tavily credential in the runtime environment.
NemoClaw does not enable Tavily or LangSmith by default for this harness.
Before you provide those credentials, add the required egress endpoints (use the `nemoclaw-user-manage-policy` skill) to the sandbox policy so optional integrations stay explicit.

## Troubleshooting

Use normal sandbox lifecycle commands:

```bash
nemoclaw <sandbox-name> status
nemoclaw <sandbox-name> logs --follow
nemoclaw <sandbox-name> rebuild
nemoclaw <sandbox-name> snapshot create --name before-change
```

`status` reports the selected harness as a terminal runtime and prints the interactive/headless command shape.
There is no dashboard port or long-running gateway process for this harness.

## Next Steps

- Inference Options (use the `nemoclaw-user-configure-inference` skill) to choose a provider and model.
- Backup and Restore (use the `nemoclaw-user-manage-sandboxes` skill) for snapshot and rebuild preservation details.
- Runtime Controls (use the `nemoclaw-user-manage-sandboxes` skill) for sandbox mutability and host-side control boundaries.
- Troubleshooting (use the `nemoclaw-user-reference` skill) for common setup and runtime issues.
