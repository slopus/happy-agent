/**
 * The commented starter configuration written to a fresh installation's global happy.toml.
 * Every setting ships commented out so the built-in defaults keep applying until the person
 * deliberately uncomments one.
 */
export const HAPPY_TOML_TEMPLATE = `# Happy configuration for Happy Agent.
# Uncomment only the settings you want to change. Happy Agent uses its built-in defaults for everything
# left commented out.

# [defaults]
# provider = "codex"
# model = "openai/gpt-5.6-sol"
# effort = "medium"
# permission_mode = "auto"
# service_tier = "default"
# instructions = "Additional instructions for every Happy Agent session."

# [settings]
# inference_max_retries = 10
# max_collaborators = 5
# max_collaboration_depth = 3
# tool_result_retention_days = 7
# compact_completed_turns = false
# completion_chime = false
# daemon_heap_snapshots = false
# durable_global_event_queue = false
# happy_integration = true
# Show the agents in the macOS menu bar while the daemon runs. Only a released Happy Agent
# binary carries the menu bar app; a daemon run from a source checkout never has one.
# menu_bar = true
# show_reasoning = false
# show_usage = false

# Ethan mode is token-max mode for token-rich users: always retry forever on every error, keep
# consuming tokens, and survive failures providers classify as fatal. Explicit cancellation and
# daemon shutdown still stop it.
# [settings.ethan]
# enabled = false

# [features]
# cross_workspace = false
# workflows = true
# workspaces = true

# [workspace]
# setup_commands = ["pnpm install"]
# Project files copied into every workspace and re-copied whenever the project root
# copy changes, such as gitignored .env files. Sync is one-way: the root copy wins.
# sync = [".env"]
# Synced like sync, and additionally protected from writing without Full access.
# protected_sync = [".env.production"]

# [theme]
# primary = "default"
# secondary = "dim"
# accent = "cyan"
# brand = "ansi:202"
# success = "green"
# warning = "yellow"
# error = "red"

# [network]
# allowed_domains = ["api.example.com", "*.example.org"]
# denied_domains = ["uploads.example.org"]
# allowed_ports = [443]
# allowed_loopback_ports = [3000]
# allow_local_binding = false

# Existing workspace-relative files and directories that require Full access to modify.
# Missing paths are ignored until the session is recreated.
# [permissions]
# protected_paths = ["master-plans", ".env.production"]

# [p2p]
# name = "My Mac"
# enable_direct = false
# enable_iroh = true
# enable_ssh = false
# expose_api = false
# role = "primary"
#
# [p2p.direct]
# listen = "0.0.0.0:7443"
#
# [p2p.iroh]
# relay_url = "https://relay.example.com"

# [presence]
# current = "available"
# fallback = "away"
# until = "2026-12-31T18:00:00Z"

# [presence.states.available]
# title = "Available"
# emoji = "🟢"
# prompt = "The user is currently available."
# answer_wait = "15 minutes"

# [providers]
# Providers start disabled and the local credential scan enables discovered accounts.
# default_enable = false

# [providers.codex]
# type = "codex"
# A new local credential detection writes auto_enable = true to generated runtime.toml.
# Set auto_enable = false to prevent automatic use.
# auto_enable = false
# enabled = true
# auth_file = "/absolute/path/to/auth.json"
# base_url = "https://api.openai.com/v1"
# transport = "auto"
# include_models = ["openai/gpt-5.6-sol"]
# exclude_models = []
# include_subagent_models = ["openai/gpt-5.6-terra"]
# exclude_subagent_models = []

# [providers.claude]
# type = "claude"
# enabled = true
# config_dir = "/absolute/path/to/claude/config"
# executable = "/absolute/path/to/claude"
# oauth_token = "token"
# include_models = ["anthropic/sonnet-5"]
# exclude_models = []
# include_subagent_models = ["anthropic/sonnet-5"]
# exclude_subagent_models = []

# [providers.grok]
# type = "grok"
# enabled = true
# auth_file = "/absolute/path/to/auth.json"
# base_url = "https://api.x.ai/v1"
# include_models = ["xai/grok-build"]
# exclude_models = []
# include_subagent_models = ["xai/grok-build"]
# exclude_subagent_models = []

# [providers.bedrock]
# type = "bedrock"
# enabled = true
# region = "us-east-1"
# The token itself, or the name of the variable holding it. The token written here wins.
# bearer_token = "your-amazon-bedrock-api-key"
# bearer_token_env_var = "AWS_BEARER_TOKEN_BEDROCK"
# Model that answers bedrock_web_search. Bedrock hosts Web Search on its GPT models, in
# us-east-1, us-east-2, and us-west-2 only. Defaults to GPT-5.6 Luna.
# search_model = "openai/gpt-5.6-luna"
# include_models = ["openai/gpt-5.6-sol"]
# exclude_models = []
# include_subagent_models = ["openai/gpt-5.6-sol"]
# exclude_subagent_models = []

# [providers.bedrock.model_overrides."openai/gpt-5.6-sol"]
# endpoint = "https://bedrock-mantle.us-east-1.api.aws"
# region = "us-east-1"
# transport = "mantle"

# A smart provider is a virtual account backed by compatible concrete providers. It picks a
# random starting account for each agent, stays there, and advances through this list only when
# that account is signed out or has exhausted its tokens. Missing providers, different provider
# kinds, unsupported models, and mismatched Bedrock regions are ignored for that route.
# [providers.smart]
# type = "smart"
# strategy = "round_robin"
# providers = ["codex-work", "codex-personal"]
# enabled = true
# include_subagent_models = ["openai/gpt-5.6-terra"]
# exclude_subagent_models = []

# Gemini powers the universal media and search tools rather than chat models, so it has no
# [providers.*] entry. The key written here wins over the GEMINI_API_KEY environment variable.
# [gemini]
# api_key = "your-gemini-api-key"

# [docker]
# Choose exactly one of image or container.
# image = "my-project-dev:latest"
# container = "existing-container"
# workdir = "/workspace"
# socket_path = "/var/run/docker.sock"
# The following options apply only when image is set.
# name = "happy-agent-session"
# env = { NODE_ENV = "development" }
# mounts = [{ source = "/host/path", target = "/container/path", read_only = true }]

`;

export const MCP_TOML_TEMPLATE = `# Happy Agent MCP servers. Changes can be reloaded without restarting the daemon.

# [mcp_servers.local]
# command = "my-mcp-server"
# args = ["--stdio"]
# env = { API_TOKEN = "token" }
# cwd = "/absolute/working/directory"
# enabled = true
# startup_timeout_sec = 10
# tool_timeout_sec = 30
# enabled_tools = ["search"]
# disabled_tools = []

# [mcp_servers.remote]
# url = "https://example.com/mcp"
# http_headers = { "X-Client" = "Happy Agent" }
# bearer_token_env_var = "MCP_BEARER_TOKEN"
# enabled = true
# startup_timeout_sec = 10
# tool_timeout_sec = 30
# enabled_tools = ["search"]
# disabled_tools = []
`;
