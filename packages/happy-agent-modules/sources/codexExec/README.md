# Codex exec

Native Codex runs its GPT-6 and GPT-5.6 models (`tool_mode: "code_mode_only"`) in code mode. The
model gets one freeform `exec` tool that runs JavaScript, and every other tool is reachable inside
it as `tools.<name>`. Independent reads, searches, and commands then go out together in one
request, with `Promise.allSettled`, instead of one request per call.

`CodexExecModule(config, permissions)` gives the same surface to those models on the `codex`
provider. It is on by default and can be turned off:

```toml
[feature.codex_exec]
enabled = false
```

```text
final tool array ──► CodexExecModule.overrideTools
                       ├─ provider-owned tools, userInput, collaboration ─► kept direct
                       └─ everything else ─► nested inside exec
```

- **Instructions.** While `exec` is offered, the module contributes native Codex's two batching
  lines from its GPT-6 instructions.
- **Isolate.** Each `exec` call runs in a fresh QuickJS WebAssembly instance. It has no Node APIs,
  filesystem, or network. Its globals are `tools`, `ALL_TOOLS`, `text`, `image`, `exit`,
  `setTimeout`, and `clearTimeout`.
- **Nested calls.** Each nested call is validated against its tool's own schema and decided by
  `PermissionsModule.decideToolCall`, the same decision a direct call gets: mode limits, Auto
  review, temporary elevation, and the refusal circuit. It then runs under that decision and must
  return a result that matches its tool's own schema. The script receives the structured result,
  and a refusal reaches the script as an exception.
- **Description.** The `exec` description declares the eager nested tools in Codex's TypeScript
  form. Deferred tools appear only in `ALL_TOOLS`, together with their declarations.
- **Not supported.** This version has no `wait` tool and no yielded cells: a script runs until it
  finishes. A command that outlives its own `yield_time_ms` keeps running as a session that a later
  `tools.write_stdin` can poll. `store`/`load`, `notify`, `yield_control`, and audio are also not
  provided. Nested calls are not shown as separate history rows; permission reviews attach to the
  `exec` call.
