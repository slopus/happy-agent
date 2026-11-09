# System prompts

## Porting Claude prompts

Each Claude prompt in `prompts/claude/` is ported from the prompt the pinned Claude Code / Agent SDK
builds for that model with its `claude_code` preset. Capture it against a local mock or loopback
server so no API traffic is sent, and record the Claude Code version in the commit message.

Keep only what Happy Agent has. Always remove:

- skill slash commands and the Session-specific guidance section;
- Claude Code's memory sections, `# Memory` and "Memory, notes and feedback";
- `# Environment`, with its model ID list, Claude Code surfaces, and `/fast`;
- the sentence about hooks;
- the games line ("Do build original games … Don't build a recreation of a specific existing
  game"). It is removed on purpose; do not re-add it when porting a newer prompt.

Keep anything that matches Happy's behavior on purpose, such as the note that Edit works without a
prior Read, which agrees with `compute/impl/computeInstructionsForVendor.ts`.

Put the knowledge cutoff wherever the CLI puts it. Newer CLIs send it in the first-prompt
attachment rather than the system prompt. Check the date against Anthropic's model page.

Each new model gets its own prompt file, an entry in `impl/systemPromptForModel.ts`, and a unit test
in `tests/systemPrompt/SystemPromptModule.test.ts` that asserts its identity and the absence of the
removed sections. The full procedure for a new model is the
[Adding a new Claude model](../../../happy-providers/VENDOR_CLAUDE.md#adding-a-new-claude-model)
checklist.
