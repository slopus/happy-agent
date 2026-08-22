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

Released installations check for a newer Happy Agent in the background. When one is available,
the terminal shows the host command to run, such as `happy upgrade` or
`happy-terminal upgrade`. The standalone command downloads and verifies the newest Agent release,
selects it, and gracefully reloads the daemon onto it. A local source checkout continues to run its
sources and must be updated through the checkout instead.

## Embed in a Node.js application

```ts
import { runHappyTerminal, upgradeHappyAgent } from "@slopus/happy-terminal";

if (process.argv[2] === "upgrade") {
    await upgradeHappyAgent();
} else {
    await runHappyTerminal({
        commandName: "my-command",
        cwd: process.cwd(),
    });
}
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
package version helper is available from `@slopus/happy-terminal/package-version`. Embedding hosts
that provide a custom `commandName` should route that command's `upgrade` entry point through
`upgradeHappyAgent()` so the suggestion shown by the terminal is actionable.

## Happy Agent daemon

Happy Terminal connects to an already-running Happy Agent daemon first. In this repository it runs
the local Happy Agent sources. A published installation instead downloads the latest matching
macOS or Linux release once, verifies it, and records the selected installed version under
`~/.happy/dist/config.json`.
