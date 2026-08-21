import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const artifacts = resolve(import.meta.dirname, "../../artifacts/session-metadata");
const happyTerminalCommand = "node /app/packages/happy-terminal/dist/main.js";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("settled session metadata", () => {
    it("updates conservatively, appears in resume, and chimes once per live settlement", async () => {
        await mkdir(artifacts, { recursive: true });
        const gym = await createGym({
            cols: 100,
            rows: 36,
            mode: "docker",
            entrypoint: [
                "bash",
                "-lc",
                [
                    happyTerminalCommand,
                    "echo INITIAL_TITLE_VIEW",
                    `${happyTerminalCommand} monit`,
                    "read -r _",
                    `${happyTerminalCommand} resume --last`,
                    "echo UPDATED_TITLE_VIEW",
                    `${happyTerminalCommand} monit`,
                    "read -r _",
                    "echo RESUME_PICKER_VIEW",
                    `exec ${happyTerminalCommand} resume`,
                ].join("; "),
            ],
            homeFiles: {
                "Happy/Config/happy.toml": "[settings]\ncompletion_chime = true\n",
            },
            inference(request, callIndex) {
                if (request.options.sessionId?.endsWith(":title")) {
                    throw new Error("Metadata requests should use the Gym automatic response.");
                }
                return {
                    content: [
                        {
                            text: callIndex === 0 ? "FIRST_TURN_COMPLETE" : "SECOND_TURN_COMPLETE",
                            type: "text",
                        },
                    ],
                };
            },
        });
        running.add(gym);
        let rawOutput = "";
        const stopOutputCapture = gym.terminal.onOutput((data) => {
            rawOutput += data;
        });

        gym.terminal.type("Implement delayed session metadata.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("FIRST_TURN_COMPLETE", 30_000);
        // The first turn produces two metadata requests: an immediate title from the
        // first user message, then one refinement after the first agent response.
        await expect
            .poll(() => metadataRequestCount(gym), { interval: 250, timeout: 75_000 })
            .toBe(2);
        expect(standaloneBellCount(rawOutput)).toBe(1);
        expect((await gym.terminal.snapshot()).title).toBe("Happy Terminal - Gym session");

        gym.terminal.press("ctrlD");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("INITIAL_TITLE_VIEW") &&
                snapshot.text.includes("Gym session"),
            "the initial settled title in session monitoring",
            30_000,
        );
        await gym.terminal.screenshot(`${artifacts}/initial-title.png`);
        expect(standaloneBellCount(rawOutput)).toBe(1);

        gym.terminal.press("enter");
        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);
        expect(standaloneBellCount(rawOutput)).toBe(1);
        gym.terminal.type("Keep the current title unless it is clearly misleading.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SECOND_TURN_COMPLETE", 30_000);
        // The single refinement already ran, so the second turn adds no metadata request.
        await expect
            .poll(() => metadataRequestCount(gym), { interval: 250, timeout: 75_000 })
            .toBe(2);
        await expect
            .poll(() => standaloneBellCount(rawOutput), { interval: 50, timeout: 5_000 })
            .toBe(2);
        const metadataRequests = gym.inference.requests.filter((request) =>
            request.options.sessionId?.endsWith(":title"),
        );
        expect(JSON.stringify(metadataRequests[1]?.context.messages)).toContain(
            "Current title: Gym session",
        );

        gym.terminal.press("ctrlD");
        await gym.terminal.waitUntil(
            (snapshot) => {
                const marker = snapshot.text.indexOf("UPDATED_TITLE_VIEW");
                return marker >= 0 && snapshot.text.slice(marker).includes("Gym session");
            },
            "the conservatively retained title in session monitoring",
            30_000,
        );
        await gym.terminal.screenshot(`${artifacts}/conservative-updated-title.png`);

        gym.terminal.press("enter");
        const picker = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Resume a session") &&
                snapshot.text.includes("The user worked with Happy Agent in the Gym environment."),
            "the resume picker recap",
            30_000,
        );
        expect(picker.text).toContain("Gym session");
        expect(picker.text).toContain("Use ↑/↓ to move, Enter to resume, Esc to cancel.");
        expect(standaloneBellCount(rawOutput)).toBe(2);
        await gym.terminal.screenshot(`${artifacts}/resume-picker-recap.png`);
        await writeFile(
            `${artifacts}/chime-assertion.txt`,
            [
                "PASS: completion chime emitted exactly once per live settlement.",
                "After first live settlement: 1 standalone BEL.",
                "After first resume replay: still 1 standalone BEL.",
                "After second live settlement: 2 standalone BELs.",
                "After final resume picker replay: still 2 standalone BELs.",
                "OSC terminators were excluded from BEL counting.",
                "",
            ].join("\n"),
            "utf8",
        );
        stopOutputCapture();
    }, 210_000);
});

function metadataRequestCount(gym: Gym): number {
    return gym.inference.requests.filter((request) => request.options.sessionId?.endsWith(":title"))
        .length;
}

function standaloneBellCount(output: string): number {
    let bells = 0;
    let inOsc = false;
    for (let index = 0; index < output.length; index += 1) {
        const character = output[index];
        if (character === "\x1b" && output[index + 1] === "]") {
            inOsc = true;
            index += 1;
            continue;
        }
        if (character === "\x07") {
            if (!inOsc) bells += 1;
            inOsc = false;
            continue;
        }
        if (inOsc && character === "\x1b" && output[index + 1] === "\\") {
            inOsc = false;
            index += 1;
        }
    }
    return bells;
}
