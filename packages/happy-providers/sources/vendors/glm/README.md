# GLM on Bedrock

`GlmProvider` serves GLM 5.3 through Bedrock Runtime's OpenAI-compatible Chat Completions endpoint.
It accepts existing Bedrock bearer-token and AWS credentials. There is no direct Z.ai provider or
Mantle transport.

```text
GlmProvider -> shared Chat Completions session -> Bedrock Runtime
     |
     +-- prompts/   Claude Code 2.1.207 reference prompt and compaction instructions
     +-- impl/      native summary formatting and continuation
```

Canonical model ID: `zai/glm-5.3`. US source regions select `us.zai.glm-5.3`; other regions select
`global.zai.glm-5.3`. Explicit profile IDs are accepted. The unprefixed native ID cannot be used
for on-demand inference; AWS requires a cross-region inference profile and eligible account.

GLM 5.3 supports text input, tool calls, structured output, and streamed reasoning. Reasoning effort
is `low`, `high`, or `max`, with `max` as the default. Replay assistant reasoning on tool turns.
Its documented context window is 1M tokens and its maximum output is 128k tokens.

Reference sources checked on October 6, 2026:

- [Official GLM 5.3 model card](https://huggingface.co/zai-org/GLM-5.3#footnotes), which names
  **Claude Code 2.1.207** for coding evaluations. DeepSWE uses mini-SWE-agent instead; there is
  no single GLM-owned harness for every benchmark.
- Official `@anthropic-ai/claude-code-linux-x64@2.1.207`, build commit
  `bc512d56332530b2be3f5079e29ec17aa20b8553`. The system asset copies its default non-Claude
  lean base (`_rg`); the compaction asset copies its `DHg` prompt. The formatter follows `$Hg`
  and `w3r`, including removing analysis markup and carrying the continuation instruction.
- [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-5-3.html).

Z.ai does not publish a separate GLM coding system prompt, nor disclose whether benchmark runs
override Claude Code's lean prompt default. The reference asset records the published default base,
not a claimed capture of Z.ai's private benchmark configuration. Runtime environment, tools, skills,
and other conditional sections are caller-owned. This provider preserves caller-supplied content;
it does not invoke Claude Code or send Anthropic requests to AWS.
