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

## Lifetime

The module starts the app, restarts it if it falls over, and stops it during shutdown. The app also
watches its own standard input, which the daemon holds open and nothing writes to: a daemon that
died without stopping its children still takes the menu bar down with it.

An exit code of zero means the app found no menu bar to join — a daemon running over SSH, for
instance — and the module stops trying rather than reporting a failure.

## Building the app

`sources/menuBar/native` is compiled by `scripts/build-menu-bar.mjs` into
`dist/menuBar/bin/happy-menu-bar-<platform>-<arch>`. It is a plain Swift executable rather than an
application bundle: it never opens a window, so it needs no `Info.plist`, and one file is what the
standalone Happy Agent binary embeds. Building on any platform other than macOS produces nothing,
and a build tree without the app simply has no menu bar.

## Turning it off

```toml
[settings]
menu_bar = false
```
