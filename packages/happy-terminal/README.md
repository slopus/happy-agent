# Happy Terminal

Happy Terminal is the terminal interface for Happy Agent. The published `@slopus/happy-terminal`
package can be installed as a command, embedded directly in another Node.js application, used by
the `happy` CLI, or hosted by Happy Desktop.

## Command line

```sh
pnpm add --global @slopus/happy-terminal
happy-terminal
```

The global package installs both `happy-terminal` and the compatibility alias `rig`; they launch
the same command:

```sh
rig
```

The separate Happy CLI also integrates Happy Terminal and exposes it through `happy`.

## Embed in a Node.js application

```ts
import { runHappyTerminal } from "@slopus/happy-terminal";

await runHappyTerminal({
    cwd: process.cwd(),
});
```

`runHappyTerminal()` uses the current process's stdin and stdout, takes over the terminal until the
person exits, restores terminal modes, and then resolves. It does not install the CLI's fatal-error
handlers and does not exit the host process. Startup failures reject the returned promise. A host
can observe non-fatal background failures with `onError`:

```ts
await runHappyTerminal({
    cwd: "/path/to/project",
    onError: (error) => applicationLogger.error(error),
});
```

Embedded sessions use `happy` in resume instructions by default. A different host command can be
provided with `commandName`. An embedded host may also provide `version` to replace the installed
Happy Terminal package version in the startup UI.

Run only one inline terminal at a time because each instance owns the process terminal while it is
active. Happy Terminal requires Node.js 24 or newer.

The embedding options type is exported as `RunHappyTerminalOptions`. Happy Agent API types belong
to `@slopus/happy-agent-client`; embedding the TUI does not create a second API contract. The
package version helper is available from `@slopus/happy-terminal/package-version`.

## Happy Agent daemon

Happy Terminal connects to an already-running Happy Agent daemon first. In this repository it runs
the local Happy Agent sources. A published installation instead downloads the latest matching
macOS or Linux release once, verifies it, and records the selected installed version under
`~/.happy/dist/config.json`.
