# Menu bar learnings

## The menu bar is macOS only, and deliberately so

Linux has no dependable cross-desktop tray standard worth carrying, so the app is a Swift AppKit
executable and nothing is built for Linux. Do not add a cross-platform tray implementation or a
second rendering path to "finish" the feature.

## It is on by default, and turned off in configuration

The module starts the app whenever the daemon runs on macOS. There is no opt-in flag; `menu_bar =
false` under `[settings]` is the way off. The app itself decides whether a machine actually has a
menu bar, by checking for a login session, and exits cleanly when there is none — a daemon started
over SSH must not look like a failure.

## The status item shows no count and the menu has no footer

The bar carries the glyph alone: no number, no badge. The menu ends after the token totals — there
is no version line, no ready/draining state, and no Quit item. A Quit item would be a lie, because
the module would start the app again. These were explicit product decisions, not omissions.

## What the menu shows

Working agents grouped by project, provider plan usage, and rolling token totals. Idle agents are
not listed at all, not even collapsed into a count.

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

## The app is a reader

It speaks the ordinary HTTP API over the daemon's private socket with the same bearer token as any
other client. It performs no mutation, and it must not gain one. The event stream is a change
signal only: every snapshot the menu draws is re-read, so an unfamiliar or missed event cannot
leave stale state on screen.

## Supervision waits for exit, not for the streams to close

`close` on a child process waits for its stdio to close, which anything the app leaves behind can
hold open indefinitely. Supervision therefore ends a run on `exit` and gives the error pipe only a
brief moment to drain. A test covering an app that leaves a grandchild behind catches a regression
here.
