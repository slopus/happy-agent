# Codex exec learnings

## Responses Lite without exec costs requests

Native Codex sends `parallel_tool_calls: false` to every model on Responses Lite. Those models make
their parallel calls inside one `exec` script instead. When Happy Agent gave GPT-6.1 Sol the Lite
envelope but kept every tool direct, the model lost parallel calls and had nothing to replace
them, so each call took its own request. The Lite envelope and `exec` must therefore ship
together for the same models. The closed model list here is the models native Codex marks
`code_mode_only`.

## What stays beside exec

Native Codex keeps asking the person and coordinating agents outside `exec`. A question may wait
for days, and that wait cannot sit inside a script. These are kept direct as whole module
contributions (`userInput`, `collaboration`), along with provider-owned tools, which the provider
settles inside its response. Every other tool is nested, so a new module's tools are reachable
from `exec` without any change here.

## One permission decision for direct and nested calls

A nested call never skips the permissions module. Its arguments are validated, then
`PermissionsModule.decideToolCall` decides it with the same code that decides a direct call, and
it runs under the mode that decision returns. The `exec` call itself is never reviewed and never
elevated, because running JavaScript in the isolate touches nothing. Permission events name the
`exec` call, because that is the call the conversation holds and the API attaches reviews to.

## A cell is a fresh WebAssembly instance

Creating a QuickJS instance from the single-file build takes a few milliseconds. Giving each cell
its own instance means nothing a script does can leak into another cell. It also lets the
instance be dropped whole: disposing a runtime asserts that every guest handle was released, and
a script that left promises behind cannot guarantee that. Synchronous computation is interrupted
after ten seconds without an `await`. Awaits have no overall cap, because nested tools bound their
own waits. A script left awaiting something nothing can settle fails at once rather than hanging.
