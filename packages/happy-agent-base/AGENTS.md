# Agent Instructions

## Chaos tests

Every test under `tests/chaos/` is an opt-in stress gate. The normal package test command excludes
the directory completely. Never run the chaos gate unless a human explicitly asks for it in the
current task. When authorized, run it with `pnpm --filter @slopus/happy-agent-base test:chaos`.
