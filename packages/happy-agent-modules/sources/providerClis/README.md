# Provider CLIs

Happy runs on the coding assistants people already use: Claude Code, Codex, Grok, and
Antigravity. This module finds each assistant's program on the computer, tells whether it is signed
in, installs a missing one with its vendor's official installer, and runs the vendor's own sign-in.
Happy never handles a password. It starts the vendor program and relays what that program prints,
so the desktop can show progress and the page to open. A pasted setup token or API key goes only
through the vendor's own credential path (`saveToken`): Codex reads an OpenAI key on
`codex login --with-api-key`'s standard input, and a Claude setup token or key becomes a Claude
provider in `runtime.toml`, used after the next start.

`ProviderClisModule` takes the config module, the provider scan module, and the Durable Functions
module. The config module supplies the environment and the folders to search, so tests and isolated
installations can point discovery somewhere else. After an install or sign-in succeeds, the module
runs the provider scan so the new assistant's models show up without a restart.

Given Chat UI, the module contributes `provider_sign_in` (`impl/signInComponent.ts`): install,
sign in, submit a code, submit a token, and cancel, each calling this module directly. The code and
token are `Secret` fields. When a widget's sign-in finishes, its `sign_in` finds the assistant
signed in already, or its token connects it, `onConnected` listeners hear which conversation
connected it, and the conversation gets a hidden note that wakes its model. A listener that tells
the conversation itself, as onboarding does for the Chief of Staff, answers `true`, and the note
then joins that turn instead of starting one. With its `account: "new"` prop, `sign_in` adds another
account instead (below), returns `{ accountId }`, and the note waits until that account reads signed
in.

It also contributes the `provider` reply component (`impl/providerReply.ts`), which puts an AI's
mark and live state beside a quick reply. Clients read that state from this module's objects; its
`check` refuses an AI that has no provider CLI here.

## The catalog

`impl/providerCliCatalog.ts` holds one definition per assistant: its name, vendor, official site,
program name, the commands to run it and sign in, the installer for each platform, where the
vendor's installer and desktop apps put the program, and how each sign-in method reads its output.
Installers are the vendors' published one-liners (`curl … | bash` on macOS and Linux, `irm … | iex`
on Windows). The object discloses the exact command, the URL it downloads, and the vendor's site
before anything runs, so the desktop can show them and the person can decide.

## Finding programs

Discovery checks the known install locations first, including copies inside the vendors' desktop
apps (the Claude app's bundled Claude Code, and Codex inside ChatGPT.app or Codex.app), then the
`PATH`. A program found on the `PATH` is matched back to a known source through its real path. The
program has to answer `--version` to count as installed.

## Signed-in state

Each assistant has its own check. Claude reads `claude auth status --json`. Codex runs
`codex login status` and reads the email and plan from the token claims in `~/.codex/auth.json`.
Grok reads `~/.grok/auth.json`. Antigravity checks its token file and falls back to `agy models`.
Sign-ins use each vendor's normal home folder, so an existing sign-in is reused rather than
repeated.

On macOS, the keychain is only readable from the person's desktop session. Claude Code keeps its
sign-in in the keychain, so from a daemon started outside that session it reports itself signed
out even when it is not. The module checks `launchctl managername` and reports `unknown` in that
case instead of claiming the person is signed out.

## Accounts

Each object lists `accounts`: every configured provider of the assistant's type, in configuration
order, with its own sign-in. An account whose configuration names a home folder (`config_dir` for
Claude, the folder of `auth_file` for Codex and Grok) is checked there, with `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, or `GROK_HOME` pointing the vendor's own check at it. One carrying its own key or
token is signed in. Any other uses the program's default sign-in, the one `signIn` describes.

`addAccount` signs in another Claude Code or Codex account (`impl/providerAccounts.ts`). It takes
the lowest free `claude_N` or `codex_N` (N from 2) whose folder `~/.claude-N` or `~/.codex-N` is
missing or empty, makes that folder, and runs the ordinary sign-in operation with the home variable
pointing at it. The default sign-in is never touched. Once the vendor's check confirms the new
folder, the config module adds the provider (`addProviderNow`): written to `runtime.toml`, used at
once without a restart, and added to the vendor's smart pool when there is one. The folders follow
the vendors' own multi-account convention, so the provider-routes module recognizes them as
configured. Grok and Antigravity keep no account folders and refuse `addAccount`.

## Operations

Install and sign-in are Durable Functions keyed by the assistant, so only one runs per assistant
and a second request joins the first. The vendor program runs in the durable call's context, never
the request's. Output is read line by line and kept to the last 20 lines; updates are coalesced to
one `provider_cli.updated` event every 250 ms. A sign-in watches the output for the vendor's page
and, for device sign-in, its code, then moves to `waiting` with an `authorization` describing what
the person needs to do. When the vendor page shows a code to paste back, `submitCode` writes it to
the program's input.

A sign-in cannot survive a restart, because the program waiting for the browser dies with the
daemon. The sign-in function stores an attempt marker on its first run; a rerun that finds the
marker ends the operation as `interrupted` instead of starting a new sign-in on its own. An
install that reruns after a restart simply runs the vendor installer again.

## Reaching it

`ApiModule` serves the module under `/v0/provider-clis` and turns each change into a
`provider_cli.updated` event, plus `config.updated` when an operation succeeds. `packages/happy-agent/API.md`
is the contract.

## A connection wakes the conversation, once

A sign-in note used to wait for the person's next message, so a model that showed a sign-in sat
silent after the person connected, and onboarding's guided part never heard about an AI connected
from a widget it showed or from the person's own terminal. A connection now leaves its note with a
wake. Onboarding's `onConnected` listener claims the Chief of Staff's conversation and tells it
with its own `providerAdded` (or the opening's hand-off) instead, so the person's one connection is
one turn, with the note riding along.
