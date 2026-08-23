# Menu bar

A small native macOS app that puts the agents in the system menu bar. Clicking it shows how many
agents are working and in which projects, how much of each provider's plan is spent, and the tokens
spent in the last hour and day.

```text
MenuBarModule ──spawns──> happy-menu-bar (Swift, AppKit)
      │                          │
      └── ConfigModule           └── GET /v0/projects, /v0/workspaces, /v0/usage
          socketPath, tokenPath      GET /v0/events/stream
```

The app is a reader. It speaks the ordinary Happy Agent HTTP API over the same private Unix socket
every other client uses, with the same bearer token, so it can show nothing the person could not
already see and can change nothing at all.

The event stream is used only as a signal that something changed; the snapshots the menu draws are
always re-read. An unfamiliar or missed event therefore cannot leave stale state on screen.

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

An exit code of zero means the app found no menu bar to join — a daemon running over SSH, for
instance — and the module stops trying rather than reporting a failure.

## Building the app

`sources/menuBar/native` is compiled by `scripts/build-menu-bar.mjs` into
`dist/menuBar/bin/happy-menu-bar-<platform>-<arch>`, which is what the standalone Happy Agent
binary embeds. It is a plain Swift executable rather than an application bundle: it never opens a
window, so it needs no `Info.plist`, and one file is what the binary can carry. Building on any
platform other than macOS produces nothing.

## Turning it off

```toml
[settings]
menu_bar = false
```
