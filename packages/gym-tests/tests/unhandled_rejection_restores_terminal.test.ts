import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxEntry = pathToFileURL(
    createRequire(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json")).resolve(
        "tsx",
    ),
).href;
const typeScriptHook = join(
    repositoryRoot,
    "packages/gym/sources/registerTypeScriptSourceHooks.mjs",
);
const runAppUrl = pathToFileURL(
    join(repositoryRoot, "packages/happy-terminal/sources/app/runApp.ts"),
).href;
const failureReportingUrl = pathToFileURL(
    join(repositoryRoot, "packages/happy-terminal/sources/installCliFailureReporting.ts"),
).href;
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("unhandled rejection cleanup", () => {
    it("leaves the PTY usable while preserving Node's fatal exit", async () => {
        const gym = await createGym({
            entrypoint: ["bash", "run-rejecting-tui.sh"],
            files: {
                "rejecting-tui.mjs": rejectingTuiSource,
                "run-rejecting-tui.sh": shellHarnessSource,
            },
            mode: "just-bash",
        });
        running.add(gym);

        await gym.runInContainer("touch", ["trigger-fatal-rejection"]);
        const crashed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("HAPPY_TERMINAL_TTY_RESTORED_AFTER_FATAL") ||
                snapshot.text.includes("HAPPY_TERMINAL_TTY_NOT_RESTORED_AFTER_FATAL"),
            "the shell's post-rejection TTY check",
            30_000,
        );
        const exit = await gym.exit();

        expect(crashed.text).toContain("GYM_UNHANDLED_TUI_REJECTION");
        expect(crashed.text).toContain("HAPPY_TERMINAL_TTY_RESTORED_AFTER_FATAL");
        expect(crashed.text).not.toContain("HAPPY_TERMINAL_TTY_NOT_RESTORED_AFTER_FATAL");
        expect(crashed.synchronizedOutputActive).toBe(false);
        expect(crashed.cursor.visible).toBe(true);
        expect(exit.exitCode).toBe(1);
    }, 60_000);
});

const rejectingTuiSource = String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runApp } from ${JSON.stringify(runAppUrl)};
import { installCliFailureReporting } from ${JSON.stringify(failureReportingUrl)};

// The real entry point installs this before starting the TUI, and it owns the fatal exit.
installCliFailureReporting();

const triggerPath = join(process.cwd(), "trigger-fatal-rejection");
const timer = setInterval(() => {
    if (!existsSync(triggerPath)) return;
    clearInterval(timer);
    void Promise.reject(new Error("GYM_UNHANDLED_TUI_REJECTION"));
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
node --import ${JSON.stringify(tsxEntry)} --import ${JSON.stringify(typeScriptHook)} rejecting-tui.mjs
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
