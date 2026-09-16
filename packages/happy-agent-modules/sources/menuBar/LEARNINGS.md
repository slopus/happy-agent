# Menu bar learnings

## Native status controls on macOS and Windows

macOS uses Swift AppKit. Windows now has a native notification-area app, requested to make a
background daemon visible and stoppable. It uses Windows Forms from the system .NET Framework,
with no Electron runtime. Linux still has no status app. The Windows icon is stationary and
resource/usage refreshes run only while its menu is open; parent-exit and stdin EOF notifications
end its lifetime without a process-table polling loop.

## Only a released binary has a menu bar

The app used to start from any macOS build that had compiled it, which meant working on Happy
Agent, or running its tests, put a status item in the developer's menu bar and sometimes left one
behind. It now ships in the released Happy Agent binary alone: the binary build replaces
`resolveMenuBarApp` with a resolver for its embedded copy, and the source version returns nothing
at all. Do not restore the `dist/menuBar/bin` lookup to make a development daemon show the menu
bar; build the binary and run that instead.

## It is on by default, and turned off in configuration

Within a release the module starts the app whenever the daemon runs on macOS or Windows. There is no opt-in
flag; `menu_bar = false` under `[settings]` is the way off. The app itself decides whether a machine
actually has a menu bar, by checking for a login session, and exits cleanly when there is none — a
daemon started over SSH must not look like a failure.

Team mode is the deployment exception. It has no private local API socket or token, so it never
starts the socket-dependent menu bar app even when `menu_bar` retains its standalone default.

## The app never outlives its daemon

A daemon that is killed outright never runs its shutdown handlers, so the app has to notice on its
own. It watches two things, and either is enough: end of file on the standard input the daemon holds
open, and the exit of the parent process itself through a dispatch process source. Standard input
alone was the original mechanism and is not sufficient, because anything else holding that pipe open
keeps the app alive after the daemon is gone.

## The macOS status item shows no count and the menu has no footer

The bar carries the glyph alone: no number, no badge. The menu ends after the token totals — there
is no version line, no ready/draining state, and no Quit item. A Quit item would be a lie, because
the module would start the app again. These were explicit product decisions, not omissions.

## What the menu shows

Working agents grouped by project, provider plan usage, and rolling token totals. Idle agents are
not listed at all, not even collapsed into a count.

## Plan usage shows the session and the week

The menu used to pick the single window closest to running out. That hid the week whenever the
session was the tighter limit, which is the usual case. Every provider uses the same pair: the
five-hour session and the week, each on its own line so the reset time is not cut off. Claude
also shows Fable's separate weekly allowance as a third row when Anthropic reports it. A monthly
window is shown only when there is no session window, so a Grok-style week-and-month pair still
has both numbers. Extra vendor meters such as Codex Spark are not shown.

Reset always includes a clock time. A weekday or date is added only when the reset is not today.
When the window ends in less than three hours, remaining time is added too, such as
"4:34 PM · in 2h 14m".

## The glyph is a star, drawn at full strength

The icon is a five-pointed star: still when nothing is running, turning slowly while agents work.
It replaced an equalizer of three bars, which was both the wrong mark and, at rest, indistinguishable
from an ellipsis.

Draw the template image with solid black and no alpha. An earlier version dimmed the resting glyph
to 55% alpha, which made it visibly washed out beside every other menu bar icon — macOS already
tints and inverts a template image, so anything less than full strength is wrong.

## Provider names are the person's, not the config's

A provider ID is whatever someone called their account, so `bulka_happy_codex` is shown as
"Bulka Happy Codex". Never render a raw ID.

## The existing private API is the boundary

Both apps use the ordinary HTTP API over the daemon's private socket with its bearer token.
macOS remains read-only and uses events as refresh hints. Windows uses the existing shutdown
endpoint for its explicit Stop action; if shutdown stalls, Force stop terminates the retained
parent process and its tree. No new server endpoint, public listener, or token exposure is needed.

## Supervision waits for exit, not for the streams to close

`close` on a child process waits for its stdio to close, which anything the app leaves behind can
hold open indefinitely. Supervision therefore ends a run on `exit` and gives the error pipe only a
brief moment to drain. A test covering an app that leaves a grandchild behind catches a regression
here.
