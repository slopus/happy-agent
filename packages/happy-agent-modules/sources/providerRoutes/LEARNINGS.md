# Provider routes learnings

## Discover, never run inference

The user wants onboarding to find the setups people already have, "not too invasive": discover,
never run inference. Detection reads files and the daemon's own environment and, for local servers
only, asks `GET /v1/models` on `127.0.0.1`. It never sends a completion or chat request, never calls
a remote vendor or cloud API, never probes ports it has no reason to expect, and never runs a shell,
so keys exported only in a shell profile are not seen.

## A proxy is shown only when it is detected

CLIProxyAPI and Claude Code Router re-serve accounts in ways a vendor's terms may not allow. Happy
never recommends or installs one; it shows one only when it is already on the computer.

## Each vendor is reached one way by default

The initial selection reaches every vendor through one route, so the same plan is not spent
through two routes by default. A ready vendor sign-in always starts checked. Any other ready route
starts checked only when it brings a vendor nothing checked before it already serves: a proxy that
re-serves Claude beside the Claude Code sign-in but also serves OpenAI starts checked, because
otherwise OpenAI would be lost. Local model servers always start unchecked.

## A generated provider must load on the next start

Providers are read at startup, and a runtime.toml the daemon cannot load stops it from starting.
`addRuntimeProvider` therefore merges the new table through the same validation startup uses before
writing it, and refuses an ID that already exists. OpenAI-compatible providers need a key and at
least one model, so a local server without client keys gets the placeholder key `local`, and a
server that lists no models cannot be used automatically.

## A route detection cannot vouch for can still be chosen

On macOS, Claude Code keeps its login in the keychain, which Happy never reads, and an AWS
single-sign-on session can only be checked by asking AWS. Such routes are `unknown`: shown, never
checked by default, but still offered for setup, because setting one up only writes configuration.
Hiding them would hide the extra Claude accounts of most Mac users.

## Grok scopes are not extra accounts

Grok's `auth.json` keeps one record per sign-in client. Happy's Grok provider reads only its own,
so the other records are not accounts Happy could use, and routes do not count them.
