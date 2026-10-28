# Provider CLIs learnings

## Happy uses the vendors' own sign-in, never its own

Rig deliberately has no login flow of its own. Signing in means running the vendor's program and
relaying the page it prints, so credentials stay in the vendor's normal home folder (`~/.claude`,
`~/.codex`, `~/.grok`) and every other tool that uses that assistant sees the same sign-in. No
separate credential folders are created for Happy.

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

## Never run a real vendor sign-in in tests or on a developer's computer

Probing `agy` and `codex` sign-ins on a developer Mac opened real browser sign-in pages. Tests use
stub programs on an isolated `PATH`, an isolated `HOME`, empty program directories
(`HAPPY_AGENT_PROGRAM_DIRECTORIES=""`), and a fake applications folder
(`HAPPY_AGENT_APPLICATIONS_DIRECTORY`), so nothing reaches the real assistants. Real installs and
sign-ins are verified only in a throwaway virtual machine.
