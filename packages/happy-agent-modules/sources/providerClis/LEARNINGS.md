# Provider CLIs learnings

## Pasting a setup token configures Happy Agent, not the CLI's login

Desktop's setup-token submission used to hit a missing route on every platform. Claude now
advertises `signIn.acceptsToken`, and saving delegates normalization and live persistence to
Config before scanning providers and announcing the refreshed CLI object. The token is never
included in CLI state or events. The installed program's sign-in status remains its own; a saved
token does not claim that Claude Code's credential files changed or that Anthropic accepted it.

## Happy uses the vendors' own sign-in, and can keep one for itself

Rig has no login flow of its own. Signing in always means running the vendor's program and
relaying the page it prints. The global sign-in leaves credentials in the vendor's normal home
folder (`~/.claude`, `~/.codex`, `~/.grok`), where every other tool sees the same sign-in.

That shared sign-in broke in practice: people copied `~/.codex` between machines, and because a
ChatGPT refresh token works only once, the copies signed each other out (three Codex logins on one
machine were lost this way). Steve asked for each installation to sign each account in itself, so
provider sign-in now runs the same vendor program with its home pointed at a private folder per
account under the agent home, and the account uses only that folder from then on. The global
sign-in remains for people who want one login shared with their other tools. The vendor's program
still does the signing in; Happy never handles a password.

## On macOS, a signed-out answer from outside the desktop session means nothing

Claude Code stores its sign-in in the macOS keychain, which is only readable from the person's
desktop (Aqua) session. A daemon started over SSH or by another background launcher gets
`loggedIn: false` even when the person is signed in. Treating that as signed out would push people
into signing in again for nothing, so the module reports `unknown` when `launchctl managername` is
not `Aqua`. The real fix is for the daemon to run in the person's desktop session; this check only
keeps it from lying when it does not.

## Read output line by line and never wait for the end

On Windows, a browser the vendor program starts can inherit its output pipes and keep them open
after the program exits. Waiting for the end of output then hangs forever. The module reads lines
as they arrive and settles 250 ms after the program exits. The same rule keeps sign-in responsive
everywhere: the page and code appear as soon as the program prints them.

## Antigravity has no sign-in command

`agy` has no `login` subcommand. Running a prompt while signed out prints a Google sign-in page,
waits 60 seconds for a pasted code, and then gives up. The module starts that prompt as the sign-in
and bounds the wait to the program's own timeout, so the desktop shows the page and accepts the
code within that minute.

## Signing in to Antigravity has to turn its account on

Kirill found that Antigravity could be set up only through the chief or by hand. agy installed and
signed in fine from onboarding, but no Antigravity account existed unless someone wrote
`[harnesses.antigravity]` into `happy.toml` and restarted. The provider scan that runs after a
sign-in had nothing to turn on, and `providerId` stayed `null`. Even with the table written, the
account was never matched to the CLI, because the provider registry files agents with their own
login as `foreign` rather than `antigravity`.

Antigravity is now a built-in account like Grok's: it starts off, and a written table still decides
it. The scan cannot read agy's keyring, so this module's own check is the discovery. Whenever that
check finds agy signed in, after a sign-in or on a refresh, the module calls
`ProviderScanModule.recordDiscovery`. That turns the account on live, under the scan's rules: an
explicit setting or `auto_enable = false` still wins. Matching an account to its CLI uses the
configured type whenever the registry says `foreign`.

Kirill decided that detection stays automatic: an agy already signed in on the computer counts as
connected without signing in again through Happy. Listing the provider CLIs refreshes each one, so
onboarding sees `signIn.status` `signed_in` with `providerId` `antigravity`, and the account is
already on when the list returns.

## A sign-in is replaced only when the new one succeeds

Signing an account in again must never leave it worse off. Each attempt gets a fresh folder, the
vendor's own check against that folder decides success, and only then does one write of
`runtime.toml` switch the account. Failed, cancelled, and interrupted attempts delete their folder.
The folder being replaced is not deleted while this daemon runs, because Codex renews into the
same file a running session read from.

## Never run a real vendor sign-in in tests or on a developer's computer

Probing `agy` and `codex` sign-ins on a developer Mac opened real browser sign-in pages. Tests use
stub programs on an isolated `PATH`, an isolated `HOME`, empty program directories
(`HAPPY_AGENT_PROGRAM_DIRECTORIES=""`), and a fake applications folder
(`HAPPY_AGENT_APPLICATIONS_DIRECTORY`), so nothing reaches the real assistants. Real installs and
sign-ins are verified only in a throwaway virtual machine.
