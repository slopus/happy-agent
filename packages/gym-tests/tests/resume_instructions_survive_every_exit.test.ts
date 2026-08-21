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

/**
 * Losing the resume instructions loses the session: the id is the only way back into it. Every
 * exit that happens once a session exists has to leave those instructions on the screen.
 */
describe("resume instructions after an abrupt exit", () => {
    it("reports the session when the terminal hangs up", async () => {
        const gym = await createGym({
            entrypoint: ["bash", "run-tui.sh"],
            files: {
                "run-tui.sh": shellHarnessSource,
                "tui.mjs": tuiSource("trigger-hangup", 'process.kill(process.pid, "SIGHUP");'),
            },
            mode: "just-bash",
        });
        running.add(gym);

        await gym.runInContainer("touch", ["trigger-hangup"]);
        const exited = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("HAPPY_TERMINAL_TUI_FINISHED"),
            "the TUI to exit after the hangup",
            30_000,
        );

        expect(exited.text).toContain("Resume: happy-terminal resume ");
    }, 60_000);

    it("reports the session when a rejection kills the process", async () => {
        const gym = await createGym({
            entrypoint: ["bash", "run-tui.sh"],
            files: {
                "run-tui.sh": shellHarnessSource,
                "tui.mjs": tuiSource(
                    "trigger-rejection",
                    'void Promise.reject(new Error("GYM_FATAL_REJECTION"));',
                ),
            },
            mode: "just-bash",
        });
        running.add(gym);

        await gym.runInContainer("touch", ["trigger-rejection"]);
        const exited = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("HAPPY_TERMINAL_TUI_FINISHED"),
            "the TUI to exit after the rejection",
            30_000,
        );

        expect(exited.text).toContain("Resume: happy-terminal resume ");
    }, 60_000);
});

function tuiSource(triggerName: string, fatalAction: string): string {
    return String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runApp } from ${JSON.stringify(runAppUrl)};
import { installCliFailureReporting } from ${JSON.stringify(failureReportingUrl)};

// The real entry point installs this before starting the TUI, and it owns the fatal exit.
installCliFailureReporting();

const triggerPath = join(process.cwd(), ${JSON.stringify(triggerName)});
const timer = setInterval(() => {
    if (!existsSync(triggerPath)) return;
    clearInterval(timer);
    ${fatalAction}
}, 10);

await runApp(undefined, {
    ...(process.env.HAPPY_TERMINAL_MODEL === undefined ? {} : { modelId: process.env.HAPPY_TERMINAL_MODEL }),
    ...(process.env.HAPPY_TERMINAL_PROVIDER === undefined ? {} : { providerId: process.env.HAPPY_TERMINAL_PROVIDER }),
    ...(process.env.HAPPY_TERMINAL_PERMISSION_MODE === undefined
        ? {}
        : { permissionMode: process.env.HAPPY_TERMINAL_PERMISSION_MODE }),
});
// The gym runs the daemon in this process, so the real entry point exits explicitly too.
process.exit(0);
`;
}

const shellHarnessSource = String.raw`
node --import ${JSON.stringify(tsxEntry)} --import ${JSON.stringify(typeScriptHook)} tui.mjs
printf '\r\nHAPPY_TERMINAL_TUI_FINISHED\r\n'
`;
