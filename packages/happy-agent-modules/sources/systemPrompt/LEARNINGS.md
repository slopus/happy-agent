# System prompt learnings

## Kimi K3 and GLM 5.3 follow their documented harnesses

Kimi K3 uses Moonshot's Kimi Code system prompt, with Happy's identity and environment sections.
Kimi's native environment claims an unsandboxed shell and its own secret-file guards, which do not
describe Happy, so those sections belong to Happy's environment module instead. GLM 5.3's official
model card names Claude Code 2.1.207 for its coding evaluations; its prompt follows that version's
default non-Claude lean base. Z.ai does not publish a separate GLM coding prompt or disclose whether
its benchmark runs override the lean default. Keep that provenance explicit rather than inventing
a GLM-specific prompt. Reference copies in the provider package remain vendor text; these product
copies remove unsupported hooks and replace only identity and environment-owned material.

## Windows guidance must describe the executing shell

Agent configuration captured `SHELL`, which is commonly absent on Windows or inherited from Git
Bash. Native Compute always runs Windows PowerShell 5.1, so Windows prompts name that actual
default on every inference, including for existing agents. Guidance covers PowerShell quoting,
environment variables, exit checks, file paths, and hidden background helpers. Claude exposes
PowerShell on native Windows; Codex keeps exec_command. Bash belongs to Unix/WSL environments,
and native Windows does not support Git Bash. Tool descriptions must agree with this executor.

## Codex prompts come from Codex's model catalog

A Codex model's own prompt is its `instructions_template` from
`codex-rs/models-manager/models.json` in openai/codex, with `You are Codex` and `As Codex` turned
into Happy Agent's identity markers. The model's separate `persistent_instructions` belong to
Codex's persistent mode and are not part of the prompt. GPT-6.1 Sol is the first Codex model with a
prompt of its own; the others still share the GPT-5.6 template taken the same way, even where Codex
now ships a newer one for them.

## Prompts mention only what Happy Agent has

Vendor prompts describe their own product, and a model told about a tool or feature it does not
have will look for it, cite it, or tell the user to use it. Every prompt here is therefore the
vendor's text minus what Happy Agent lacks, and nothing more: Codex apps and plugins, code mode's
`functions.exec` (Happy's code mode replaces the whole prompt and names its own tools), the
asynchronous `request_user_input_async` tool (Happy's `request_user_input` waits for the answer),
memory, interactive and inline visualizations, `# System prompt learnings

## Windows guidance must describe the executing shell

Agent configuration captured `SHELL`, which is commonly absent on Windows or inherited from Git
Bash. Native Compute always runs Windows PowerShell 5.1, so Windows prompts name that actual
default on every inference, including for existing agents. Guidance covers PowerShell quoting,
environment variables, exit checks, file paths, and hidden background helpers. Claude exposes
PowerShell on native Windows; Codex keeps exec_command. Bash belongs to Unix/WSL environments,
and native Windows does not support Git Bash. Tool descriptions must agree with this executor.

## Codex prompts come from Codex's model catalog

skill mentions, orchestrator and
environment-owned skills with `skills.list`, `skills.read`, and aliased skill roots, Claude Code's
hooks and `TaskCreate`, and Grok's `monitor` tool. Codex skill guidance names the `# Skills`
section Happy's skills module actually writes. The vendor copies in `happy-providers` stay
verbatim; only these prompts are edited. Check a new or updated vendor prompt against Happy's tool
arrays and modules before adding it.
