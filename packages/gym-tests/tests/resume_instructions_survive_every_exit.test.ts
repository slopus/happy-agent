import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

// The Docker gym mounts the current Terminal sources and resolves these build paths to them.
const runAppUrl = "/app/packages/happy-terminal/dist/app/runApp.js";
const failureReportingUrl = "/app/packages/happy-terminal/dist/installCliFailureReporting.js";
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
            mode: "docker",
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
            mode: "docker",
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
    // The real entry point names its own command in the resume instructions.
    commandName: "happy-terminal",
    ...(process.env.HAPPY_TERMINAL_MODEL === undefined ? {} : { modelId: process.env.HAPPY_TERMINAL_MODEL }),
    ...(process.env.HAPPY_TERMINAL_PROVIDER === undefined ? {} : { providerId: process.env.HAPPY_TERMINAL_PROVIDER }),
    ...(process.env.HAPPY_TERMINAL_PERMISSION_MODE === undefined
        ? {}
        : { permissionMode: process.env.HAPPY_TERMINAL_PERMISSION_MODE }),
});
// Only a fatal exit may skip the harness's finish marker, so leave nothing holding the process open.
process.exit(0);
`;
}

const shellHarnessSource = String.raw`
node tui.mjs
printf '\r\nHAPPY_TERMINAL_TUI_FINISHED\r\n'
`;
