# Provider CLIs

Happy runs on the coding assistants people already use: Claude Code, Codex, Grok, and
Antigravity. This module finds each assistant's program on the computer, tells whether it is signed
in, installs a missing one with its vendor's official installer, and runs the vendor's own sign-in.
Happy never handles a password or a token. It starts the vendor program and relays what that
program prints, so the desktop can show progress and the page to open.

`ProviderClisModule` takes the config module, the provider scan module, and the Durable Functions
module. The config module supplies the environment and the folders to search, so tests and isolated
installations can point discovery somewhere else. After an install or sign-in succeeds, the module
runs the provider scan so the new assistant's models show up without a restart.

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
The provider scan cannot see Antigravity's sign-in, because agy keeps it in the OS keyring, so
whenever this check finds agy signed in the module records a discovery of the built-in
`antigravity` account with the provider scan, which turns it on under the scan's usual rules.
The global sign-in uses each vendor's normal home folder, so an existing sign-in is reused rather
than repeated.

On macOS, the keychain is only readable from the person's desktop session. Claude Code keeps its
sign-in in the keychain, so from a daemon started outside that session it reports itself signed
out even when it is not. The module checks `launchctl managername` and reports `unknown` in that
case instead of claiming the person is signed out.

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

## Signing one account in to its own credential

`impl/ProviderAccountSignIns.ts` signs one configured Codex, Claude, or Grok account in without
touching the vendor's global sign-in. It runs the same vendor program and sign-in flows as the
global sign-in, but with `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` pointed at a new private
folder the config module names for that attempt, and without credential variables such as
`OPENAI_API_KEY` in its environment. Codex gets a `config.toml` there that keeps its sign-in in a
file rather than the keyring. The vendor's own sign-in check, run against the same folder, decides
success; only then does the config module point the account at the folder (`auth_file` or
`config_dir`, with `credential_isolation`) in one write of `providers.toml`.

Each attempt is its own folder and its own Durable Function keyed by the account, so a failed,
cancelled, or interrupted attempt only deletes its folder and the account keeps what it had.
Folders an account used while this daemon ran are kept, because a session opened before a newer
sign-in may still renew its credential; the account's next sign-in after a restart deletes them.
The config module also saves a pasted Claude setup token for any Claude account. Every change is a
`provider_sign_in.updated` event carrying the whole object.

## Reaching it

`ApiModule` serves the module under `/v0/provider-clis` and turns each change into a
`provider_cli.updated` event, plus `config.updated` when an operation succeeds. It serves account
sign-ins under `/v0/providers/:providerId/sign-in` and `/token`, in team mode too but only for the
owner, as `provider_sign_in.updated` events. `packages/happy-agent/API.md` is the contract.
