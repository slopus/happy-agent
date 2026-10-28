# Provider routes learnings

## Discover, never run inference

The user wants onboarding to find the setups people already have, "not too invasive": discover,
never run inference. Detection reads files and the daemon's own environment and, for local servers
only, asks `GET /v1/models` on `127.0.0.1`. It never sends a completion or chat request, never calls
a remote vendor or cloud API, never probes ports it has no reason to expect, and never runs a shell,
so keys exported only in a shell profile are not seen.

## A proxy is shown only when it is detected

CLIProxyAPI and Claude Code Router re-serve accounts in ways a vendor's terms may not allow. Happy
never recommends or installs one; it shows one only when it is already on the computer. When a
proxy overlaps a ready sign-in of the vendor's own, the proxy starts unchecked so the same plan is
not spent through two routes by default.

## A generated provider must load on the next start

Providers are read at startup, and a runtime.toml the daemon cannot load stops it from starting.
`addRuntimeProvider` therefore merges the new table through the same validation startup uses before
writing it, and refuses an ID that already exists. OpenAI-compatible providers need a key and at
least one model, so a local server without client keys gets the placeholder key `local`, and a
server that lists no models cannot be used automatically.
