# Menu bar

A small native macOS app that puts the agents in the system menu bar. Its icon is Happy's H, the
same mark as the app icon, drawn as a 14-point transparent template glyph sized like the SF Symbols
beside it: still while nothing is working, with a cell or two at a time softly
flashing while something is, static with the middle cell dimmed when Reduce Motion is on, and
greyed out while the daemon is not answering. Clicking it shows a compact menu whose only
actions are the two at the bottom:

```text
7 working                    1.3M tokens in 24h
──────────────────────────────────────────────
CLAUDE             Plan      Session   Week  Resets
Current CLI        Max 20x    64% ◔    82% ◕  3:30 AM
Work               Max 5x     19% ◔    56% ◑  Thu
Research lab sh…              92% ◕    37% ◔  Fri
CODEX                Plan
Current CLI          Pro      88% ◕     9% ◔  Wed
GROK      Plan                 Week    Month  Resets
Current CLI  SuperGrok Heavy  80% ◕    55% ◑  Nov 9
──────────────────────────────────────────────
Release 0.42 preview                       5s
Chief of Staff                          1m 44s
Fix the login redirect loop            14m 3s
Draft the launch post                  22m 9s
Investigate the flaky gym test          1h 5m
+2 more
──────────────────────────────────────────────
Quit Happy
Stop Happy Agent
```

- The headline counts the working tasks and bots, and carries the last 24 hours of tokens as a quiet
  aside.
- Plan usage comes first, then the working sessions, so the plan rows sit at the same height every
  time the menu opens.
- Only top-level sessions are listed: the bots and the tasks the desktop sidebar shows at its top
  level (`/v0/tasks?scope=joined`, without the tasks an agent inside another task opened). A task
  or bot counts as working while its own agent, a subagent, or any subtask under it is working.
  Idle ones are not listed. The five whose turns started most recently are shown, then a quiet
  "+N more".
- The time beside a session is the desktop's running-turn clock: since the running run's
  `startedAt`, from `run.started` and `run.boundary` events, or from the agent's latest history
  page for a turn that was already running when the menu bar started.
- Plan usage is grouped by vendor, one line per configured account that has a usage source: the
  account name, the plan type in its own column just left of Session, a small ring for the
  session and the week showing what is left, and when the window holding the account back
  resets, in the Mac's local time. The plan column is as wide as the vendor's widest plan (never
  narrower than its header, at most 100 points), blank for an account without a plan, and the
  account name is what gets cut short when space runs out; the tooltip has both in full. Rings turn
  yellow under 25% left and red under 10% or when the account is exhausted. Claude's Fable
  allowance has no ring; it is in the row's tooltip, and when it blocks the account the week
  ring and the reset turn red.
- When the lists would take more than 70% of the screen, they scroll below the headline instead
  of the menu growing.
- "Quit Happy" appears only while the Happy desktop app (`com.slopus.happy`, or Happy Nightly as
  `com.slopus.happy.nightly`) is running, and quits it the way Cmd+Q does, so it closes through
  its own quit handling. It leaves the daemon running.
- "Stop Happy Agent" stops the daemon the way `happy-agent stop` does, with `POST /v0/shutdown`.
  The daemon stops the menu bar app on its way out, so the icon goes with it. The headline reads
  "Stopping Happy Agent…" meanwhile, and "Happy Agent could not stop" the next time the menu opens
  if the daemon refused. The item is disabled while the daemon is not answering.

```text
MenuBarModule ──spawns──> happy-menu-bar (Swift, AppKit)
      │                          │
      └── ConfigModule           └── GET /v0/bots, /v0/tasks, /v0/usage, /v0/config
          socketPath, tokenPath      GET /v0/agents/:id/messages (a running turn's start)
                                     GET /v0/events/stream
                                     POST /v0/shutdown (Stop Happy Agent)
```

The app is a reader with one control. It speaks the ordinary Happy Agent HTTP API over the same
private Unix socket every other client uses, with the same bearer token, so it can show nothing the
person could not already see, and the only thing it changes is asking the daemon to stop.

The event stream is used only as a signal that something changed; the snapshots the menu draws are
always re-read. `agent.*`, `task.*`, `bot.*`, and `run.*` events re-read the tasks and bots;
`provider.usage.updated` and `config.updated` re-read plan usage. An unfamiliar or missed event
therefore cannot leave stale state on screen.

Accounts are listed in the order the desktop model picker uses: configuration order, with each
vendor placed where its first account appears, so Claude comes first and the built-in Current CLI
account leads its vendor. Hidden and disabled accounts are left out. A row never moves or disappears while its account is
waiting for a reading: before the first one it is a placeholder with empty rings, while a refresh
is under way it keeps its last reading, and a window the daemon has dropped after its reset keeps
its gauge at full.

## Only in a release

The app ships in the released Happy Agent binary and nowhere else. The binary embeds the executable
and replaces `impl/resolveMenuBarApp.ts` with a resolver that materializes it; the version in the
source tree always answers "no app", so a daemon started from a checkout, a development run, or a
test never puts a status item in anyone's menu bar. To see the menu bar while working on it, build
the binary with `pnpm --filter @slopus/happy-agent build:bun` and run that.

## Lifetime

The module starts the app, restarts it if it falls over, and stops it during shutdown. The app never
outlives the daemon that started it: it watches both its own standard input, which the daemon holds
open and nothing writes to, and the parent process itself. A daemon killed outright never gets to
stop its children, so either signal is enough to take the menu bar down with it.

Before it starts the app, the module stops any menu bar app an earlier daemon left behind: one that
launchd adopted and that runs from a `menu-bar-*` directory beside this one. Older releases watched
only standard input and could outlive their daemon. An app whose daemon is alive is never touched.

An exit code of zero means the app found no menu bar to join — a daemon running over SSH, for
instance — and the module stops trying rather than reporting a failure.

## Building the app

`sources/menuBar/native` is compiled by `scripts/build-menu-bar.mjs` into
`dist/menuBar/bin/happy-menu-bar-<platform>-<arch>`, which is what the standalone Happy Agent
binary embeds. It is a plain Swift executable rather than an application bundle: it never opens a
window, so it needs no `Info.plist`, and one file is what the binary can carry. Building on any
platform other than macOS produces nothing.

## Windows

`native/windows` is the Windows notification-area app, compiled on Windows by the .NET
Framework's own `csc.exe` (`node scripts/build-menu-bar.mjs win32-x64`), so its sources stay C# 5
and ASCII. Its menu follows the macOS one where WinForms allows: the same headline, plan usage per
account in configuration order kept still by the same plan book (placeholders, carried readings,
columns that only grow), the plan, session and week left as columns with the same red thresholds
and a small ring for the window holding the account back, the next reset in local time, and the
five most recent top-level tasks and bots with the desktop's turn time. Below them sit the
daemon's CPU and memory and the Stop and Force stop controls.

It reads the daemon only while its menu is open, every five seconds, with a one-second clock
for the session times; there is no event stream, so a turn start is read from the agent's history
each time the menu opens. The icon does not animate, because nothing is read while the menu is
closed. The release workflow's Windows packaging job is the only place it is compiled.

## Turning it off

```toml
[settings]
menu_bar = false
```
