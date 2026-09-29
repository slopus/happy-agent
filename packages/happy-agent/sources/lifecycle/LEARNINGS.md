# Daemon lifecycle learnings

## Bun optimizer crashes need a startup safeguard

Upgrading Bun from 1.4.0 to 1.4.2 fixed a reduced optimizer regression but did not
stop a later live daemon crash in JavaScriptCore's JIT exception handler. A
passing short smoke test is not proof that an engine upgrade resolves every
long-running failure. The CLI now starts a fresh VM with DFG and FTL disabled
before loading the daemon, preserving the interpreter and baseline JIT. These
options must exist before VM initialization; assigning environment variables
inside an already-running daemon does not change its optimizer settings.
