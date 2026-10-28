# Master plan 19: onboarding

## Big picture

Happy must be able to tell whether the local Rig is ready to use and, when it is
not, carry out the one onboarding action required next — from inside Happy's
chat, driven by the person clicking inline actions, not a separate wizard. Rig
owns the durable onboarding state and the work that completes each step;
`rig-connect` exposes the status and the actions to the desktop application.

Onboarding proves each requirement worked once. It is not continuous health
monitoring. Provider inference is verified with a real request during
onboarding and the success is remembered; if a provider breaks later, Rig stays
onboarded and the person asks Happy to fix it.

The required profile is the same human profile used for P2P message identity,
with a stable identity, a required name and email, and an optional avatar.

## Getting a provider ready without a terminal

Onboarding must be able to make a provider usable on a fresh machine without the
person opening a terminal, on macOS and on Windows. Rig can:

- Discover an assistant's CLI wherever it already lives, including inside the
  vendor's desktop application, and reuse an existing sign-in.
- Install a missing CLI from the vendor's official source. Before installing,
  Rig exposes exactly what it will download and from where, and the exact
  command, so the application can disclose it and offer to let the person do it
  themselves instead.
- Start the vendor's sign-in and report progress, including the URL to open for
  a browser sign-in, and detect success or failure. Where a CLI needs a
  terminal, Rig drives it itself rather than asking the person to.

These are additive, backward-compatible API capabilities (protocol 22 onward):
installing a provider CLI, and starting a provider sign-in, each streaming
progress and, for sign-in, the URL and the final result. The supported
assistants are Claude Code, Codex, Grok, and Antigravity (Gemini).

## Status surface

Two related paths, as before.

The fast path answers whether onboarding is complete for the current onboarding
version, reading only durable local state once the application has connected to
the daemon — no provider or network work.

When the fast path is not complete, the detailed path returns one current
onboarding state with the data needed to render and complete it. The states
cover: Rig unavailable (not installed, not running, or unreachable); Happy and
Rig incompatible (which must upgrade); no provider configured, with the choices
and, per provider, whether its CLI is present, installable, or already signed
in; providers being verified, with visible progress; a required profile; and
complete. The connection and compatibility states exist before daemon-owned
state can be read; once a compatible connection exists, Rig is authoritative.

## Ordered flow

1. Determine whether Rig is installed, running, and reachable; if not, return the
   availability state. Rig ships inside the desktop download, so first run does
   not require a separate install; it keeps updating itself afterwards.
2. Establish a compatible connection, returning a version-mismatch state that
   says which side must upgrade.
3. Check whether any provider is configured. If none, onboarding stops at
   provider setup, where the person chooses an assistant and Rig installs the
   CLI and starts sign-in as above.
4. Verify provider inference with a real request, showing progress. Onboarding
   continues as soon as one provider verifies; the success is persisted and not
   repeated on ordinary startup.
5. Require a profile with a name and email; an avatar is optional. This step
   cannot be skipped.
6. Mark onboarding complete for the current version.

## State and versioning

Rig persists the facts that cannot be derived cheaply, including successful
provider verification and which install or sign-in steps completed. Profile
completion is derived from the stored profile. A versioned completion marker
gives the fast path. Adding or changing a required step advances the version and
returns an existing installation to the flow only for the requirements not yet
satisfied.

## What done looks like

- Happy can show whether Rig must be installed, started, connected, or upgraded,
  and a mismatch says which side upgrades.
- On a fresh macOS or Windows machine with no CLIs, onboarding can install the
  chosen assistant's CLI and complete its sign-in without the person opening a
  terminal, after disclosing what is downloaded and from where, and offering the
  manual path.
- An assistant's CLI or sign-in that already exists, including inside its
  desktop app, is discovered and reused.
- After connection, one detailed status names exactly one next step and carries
  the data to render it.
- Provider verification shows progress and proves one configured provider can do
  real inference; the success is durable and later failure does not reopen
  onboarding.
- Onboarding cannot complete without a stored name and email; the avatar is
  optional.
- A completed version is read locally and quickly, with no internet or repeated
  inference, and a future version change returns only unmet requirements.
