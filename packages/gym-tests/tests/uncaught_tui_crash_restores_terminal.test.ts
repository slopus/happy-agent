import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

// The Docker gym mounts the current Terminal sources and resolves these build paths to them.
const runAppUrl = "/app/packages/happy-terminal/dist/app/runApp.js";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("uncaught TUI crash cleanup", () => {
    it("leaves the PTY usable while preserving Node's fatal exit", async () => {
        const gym = await createGym({
            entrypoint: ["bash", "run-crashing-tui.sh"],
            files: {
                "crashing-tui.mjs": crashingTuiSource,
                "run-crashing-tui.sh": shellHarnessSource,
            },
            mode: "docker",
        });
        running.add(gym);

        await gym.runInContainer("touch", ["trigger-fatal-crash"]);
        const crashed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("HAPPY_TERMINAL_TTY_RESTORED_AFTER_FATAL") ||
                snapshot.text.includes("HAPPY_TERMINAL_TTY_NOT_RESTORED_AFTER_FATAL"),
            "the shell's post-crash TTY check",
            30_000,
        );
        const exit = await gym.exit();

        expect(crashed.text).toContain("GYM_UNCAUGHT_TUI_CRASH");
        expect(crashed.text).toContain("HAPPY_TERMINAL_TTY_RESTORED_AFTER_FATAL");
        expect(crashed.text).not.toContain("HAPPY_TERMINAL_TTY_NOT_RESTORED_AFTER_FATAL");
        expect(crashed.synchronizedOutputActive).toBe(false);
        expect(crashed.cursor.visible).toBe(true);
        expect(exit.exitCode).toBe(1);
    }, 60_000);
});

const crashingTuiSource = String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runApp } from ${JSON.stringify(runAppUrl)};

const triggerPath = join(process.cwd(), "trigger-fatal-crash");
const timer = setInterval(() => {
    if (!existsSync(triggerPath)) return;
    clearInterval(timer);
    throw new Error("GYM_UNCAUGHT_TUI_CRASH");
}, 10);

await runApp(undefined, {
    ...(process.env.HAPPY_TERMINAL_MODEL === undefined ? {} : { modelId: process.env.HAPPY_TERMINAL_MODEL }),
    ...(process.env.HAPPY_TERMINAL_PROVIDER === undefined ? {} : { providerId: process.env.HAPPY_TERMINAL_PROVIDER }),
    ...(process.env.HAPPY_TERMINAL_PERMISSION_MODE === undefined
        ? {}
        : { permissionMode: process.env.HAPPY_TERMINAL_PERMISSION_MODE }),
});
`;

const shellHarnessSource = String.raw`
before="$(stty -g)"
node crashing-tui.mjs
status="$?"
after="$(stty -g)"
if [ "$after" = "$before" ]; then
    printf '\r\nHAPPY_TERMINAL_TTY_RESTORED_AFTER_FATAL\r\n'
else
    stty "$before"
    printf '\r\nHAPPY_TERMINAL_TTY_NOT_RESTORED_AFTER_FATAL\r\n'
fi
exit "$status"
`;
