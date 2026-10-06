# Kimi prompts

Literal official Kimi Code templates, retained separately from Happy's product prompts.

```text
system.md                  -> kimi_k3_system_prompt.ts
compaction-instruction.md   -> kimi_compaction_instructions.ts
compaction-summary-prefix  -> kimiCompactionPrefix
```

See the vendor README for source paths and revision. System-template variables remain literal;
they must be rendered by a caller reproducing the native harness. The provider sends caller-owned
system instructions without adding this template. Compaction renders only the native optional
custom-instruction block and uses the vendor's continuation contract.
