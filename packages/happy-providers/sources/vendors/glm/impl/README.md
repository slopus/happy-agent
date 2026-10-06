# GLM compaction continuation

```text
summary output -> Claude Code markup formatter -> checkpoint + continuation
```

`createGlmCompactedContext` reproduces the formatter and continuation text from the documented
Claude Code harness. The replacement is explicit, keeps the system instructions unchanged, and
does not mutate the caller's history.
