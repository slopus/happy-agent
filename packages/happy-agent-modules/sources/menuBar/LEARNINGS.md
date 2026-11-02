# Menu bar learnings

## Native status controls on macOS and Windows

macOS uses Swift AppKit. Windows now has a native notification-area app, requested to make a
background daemon visible and stoppable. It uses Windows Forms from the system .NET Framework,
with no Electron runtime. Linux still has no status app. The Windows icon is stationary and
resource/usage refreshes run only while its menu is open; parent-exit and stdin EOF notifications
end its lifetime without a process-table polling loop.

The person asked for the Windows tray to work as well as the Mac menu, so it now shows the same
model: the headline, plan rows in configuration order kept still by the same plan book, the plan,
session and week left in columns with the same thresholds, the reset in local time, and the five
most recent top-level tasks and bots with the desktop's turn time. Rows are disabled menu items
drawn by a custom renderer, so they never highlight or close the menu yet keep their colors and
ring; the right-hand columns are laid out against the shortcut column, whose width the item's
shortcut text reserves. Its icon stays still: animating it would mean reading the daemon while
the menu is closed, which the tray deliberately never does.

The tray is compiled by the system .NET Framework `csc.exe`, which accepts C# 5 only and reads
files without a byte-order mark in the system code page. Keep the sources C# 5 and ASCII, with
`\u` escapes for symbols; a literal "·" in an earlier version would have shown as mojibake. Only
the release workflow builds it, so check a change by compiling the three files against .NET
Framework 4.8 reference assemblies with `LangVersion` 5 before relying on that run.

Windows needs no orphan reaping. The tray watches its parent through a retained process handle,
which is signalled even when the daemon is killed outright, and end of input as well. It did leave
a second icon behind, though: on Windows every child-process kill is `TerminateProcess`, so
stopping the tray right after closing its input killed it before it could remove its icon, and
the shell keeps a dead process's icon until the pointer passes over it. Supervision now only
closes its input there and waits out the grace period before stopping it outright.

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

## The macOS status item shows no count, and the menu ends with two controls

The bar carries the glyph alone: no number, no badge. There is no version line, no
ready/draining state, and no item that quits the menu bar app itself: that would be a lie, because
the module would start the app again. These were explicit product decisions, not omissions.

The person found the icon stayed after quitting the desktop with Cmd+Q, because the desktop only
disconnects from the daemon and the icon lives as long as the daemon does. The menu therefore ends
with "Stop Happy Agent", which asks the daemon to shut down like `happy-agent stop` and so takes
the icon away truthfully, and "Quit Happy", shown only while the desktop (`com.slopus.happy` or
`com.slopus.happy.nightly`) runs, which terminates it by bundle ID so it closes through its own
`before-quit`. The desktop already respects a daemon stopped from here: reconnecting never starts
it again. Choosing an item closes the menu before the daemon answers, so a refused stop is shown
in the headline the next time the menu opens.

## The menu is compact: one line per thing

The earlier menu grew to about 1,900 pixels: agents grouped by project on two lines each, a
title plus three full-width bars per account, and two token lines, with nothing scrolling. The
person asked for a minimal menu at native metrics — 13-point text, 22-point rows, standard insets
— and for everything not needed to go. Every row is now one line, the last day's tokens sit
quietly on the headline's right, and when the lists would pass 70% of the screen they scroll in
their own view below the headline, because NSMenu only scrolls at the screen edge. The rows are
replaced in place while the menu is open, so the once-a-second elapsed-time tick keeps the scroll
position.

## What the menu shows: plans, then a few top-level sessions

The order is headline, plan usage, sessions. With sessions on top, every turn that started or
ended moved the plan rows, so plans come first and stay put.

Tasks and bots are the core primitives, so they are the only things listed, by name, with no
grouping by project. The menu once listed every task in the installation, including the ones an
agent opened from inside another task, and the person found it far too much. It now lists what
the desktop sidebar shows at its top level: bots, and joined tasks (`/v0/tasks?scope=joined`)
except those whose `creatorAgentId` belongs to another task's tree. Tasks a bot opened stay.
Subtasks and subagents are never rows of their own; a task or bot counts as working while its own
agent, a running subagent, or any subtask under it is working. Only the five most recently started
are shown, followed by a quiet "+N more". Idle ones are not listed, and the headline reads
"3 working" or "All idle".

The time on a session is the desktop's running-turn clock, not one of the menu bar's own. The
helper used to start a timer when it first noticed work, so a restart or a reconnect reset it
and it disagreed with the desktop. It now uses the running run's `startedAt`: from `run.started`,
from `run.boundary` when a turn hands over to the next, and, for a turn already running when the
helper started or reconnected, from the agent's latest history page. It is formatted like the
desktop's, from zero seconds.

## Plan usage: what is left, as a ring per window

Each account is one line under a small vendor header: the friendly account name, the plan type in
a column of its own, a ring for the session and one for the week, and the reset. The person asked for
remaining rather than spent, like a battery, so ring and number both show what is left; the ring
turns yellow under 25% left and red under 10% or for the window that has the account blocked.
Horizontal bars and rules were explicitly unwanted.

The plan sat right after the name until the person asked for it as its own column, left of
Session. It is left-aligned in secondary text, sized per vendor to that vendor's widest plan but
never narrower than its "Plan" header and never wider than 100 points, so "SuperGrok Heavy" fits
whole and Claude's names keep their room; an account without a plan leaves it blank. Because the
column's width differs between vendors, a header names its columns whenever the plan column or the
windows differ from the vendor above. The name is what gets cut short, never the plan column or
the gauges, and the tooltip leads with the full name and plan. The menu became 400 points wide to
make room: at 340, Grok's "Current CLI" was cut beside "SuperGrok Heavy".

The earlier menu picked the single window closest to running out, which hid the week whenever the
session was tighter, so both are always shown. A monthly window appears only when there is no
session, so a Grok-style week-and-month pair still has both. Extra vendor meters such as Codex
Spark are not shown. Gauge columns are right-aligned so the same window lines up under every
vendor, and a header names them only when its columns differ from the vendor above.

Fable's weekly allowance never gets a gauge. A Fable column, shown whenever Fable was the tightest
window, narrowed every Claude row and cut off names and plans, so it was removed at the person's
request. Fable lives in the tooltip; when it is the window blocking the account, the week's ring
turns red in its place and the reset column shows Fable's reset in red.

The reset belongs to the window holding the account back — while any window is full, Fable
included, the full window that resets last — and is red while the account is blocked. Under a day
away it is a clock time, otherwise a weekday, or a date once a weekday would be ambiguous. The
row's tooltip spells out every window with its reset time, led by which limit was reached when
the account is blocked.

Reset times are always the viewer's local time: the Mac's own time zone and locale, followed as
the system changes, and never UTC, an ISO string, or the daemon's zone. This is a product-wide
preference.

Accounts follow the desktop model picker: configuration order, which is the order of `/v0/usage`
`providers`, with each vendor placed where its first account appears. Hidden accounts are left
out there, so they are left out here.

Rows must never jump. They used to: the daemon starts every account with `usage: null` and reads
them one at a time, and the menu skipped accounts without a reading, so rows appeared one by one
and pushed each other down, and a vendor section landed wherever its first read account was. The
daemon also drops a window once its reset passes, and columns were derived from the windows of
the moment, so gauges and columns came and went. The helper now keeps a plan book: every readable
account has its row from the start, as a placeholder with empty rings until its first reading; a
row keeps its last reading and name while a refresh is under way or configuration cannot be read;
a dropped window keeps its gauge, full again after its reset; and a vendor's columns only grow.

## The glyph is Happy's H, drawn at full strength

The icon is the same H as the app icon and `logo.png`: a three-by-three grid with seven square
cells filled and only the four outer corners rounded. The person disliked the earlier star — the
wrong mark — and asked for the H everywhere. Before the star there was an equalizer of three bars,
which at rest was indistinguishable from an ellipsis.

While something is working, cells flash at random: one or two at a time dim softly to a quarter
strength and come back over most of a second. The person found a flip animation flat and asked
for random flashes that clearly show activity without being overwhelming. The timer runs only while
work is in flight, at ten frames a second, and skips frames where nothing changed. With Reduce Motion
on nothing moves; the middle cell stays dimmed instead, so working still differs from idle. While the
daemon is not answering, the button uses the system's disabled appearance.

It must look like the other status items, and nothing is ever drawn behind it. A first version
filled 16 of the 18 points with heavy cells and read as a solid block; the person asked for no
background and for the style of the icons around it. The H is now 14 points tall in the
standard 18-point image — 4-point cells and 1-point gaps — matching the height and weight of filled
SF Symbols such as `lock.fill` and `switch.2`, the way brand glyphs like Dropbox's are filled
silhouettes. It stays filled rather than outlined because the logo is filled and an outline
turns into muddy rings at 1x. Wider gaps break the H into a grid of dots; narrower ones vanish at 1x.
Cells, gaps, and placement are snapped to whole device pixels so the gaps stay crisp lines.

Draw the resting template image with solid black and no alpha. An earlier version dimmed the resting
glyph to 55% alpha, which made it visibly washed out beside every other menu bar icon — macOS already
tints and inverts a template image, so anything less than full strength at rest is wrong.

## Provider names are the person's, not the config's

A provider ID is whatever someone called their account, so `bulka_happy_codex` is shown as
"Bulka Happy Codex". Never render a raw ID.
Both native apps use configuration's friendly account name verbatim, with vendor context shown
separately, under a vendor header on both. The name is never rewritten with a plan suffix or
automatic email shortening; both show the plan type in a column of its own. Opening a menu calls the existing `POST /v0/usage/refresh`; ordinary snapshot
reads remain cached. macOS reacts to the existing usage events, while Windows reads cached
snapshots on its existing open-menu timer.

## The existing private API is the boundary

Both apps use the ordinary HTTP API over the daemon's private socket with its bearer token.
Both use the existing shutdown endpoint for their explicit Stop action, and macOS uses events
as refresh hints. On Windows, if shutdown stalls, Force stop terminates the retained parent
process and its tree; macOS stops its app as soon as shutdown begins, so it has no Force stop.
No new server endpoint, public listener, or token exposure is needed.

## A new daemon stops the apps old ones left behind

The person saw an old flashing icon still going after the work ended, and sometimes a second
icon. Releases before the parent-process watch relied on standard input alone, so an app whose
daemon was gone could live on, adopted by launchd, still showing the last state it read. Before it
starts its app, the module now lists this user's processes and stops every `happy-menu-bar` that
launchd adopted and that runs from a `menu-bar-*` directory beside its own, which is where every
release materializes its copy. An app with a live parent belongs to a running daemon and is never
chosen, and a failed listing only means nothing is stopped. Running a development build of the
app against a test daemon also puts a real second icon in the menu bar; stop it when done.

## Supervision waits for exit, not for the streams to close

`close` on a child process waits for its stdio to close, which anything the app leaves behind can
hold open indefinitely. Supervision therefore ends a run on `exit` and gives the error pipe only a
brief moment to drain. A test covering an app that leaves a grandchild behind catches a regression
here.
