import { afterEach, describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Agent Base protocol projection", () => {
    it("streams the current answer and keeps both turns in terminal history", async () => {
        const firstAnswer =
            "AGENT_BASE_STREAM_PREFIX keeps arriving one chunk at a time AGENT_BASE_STREAM_END";
        const gym = await createGym({
            async inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: firstAnswer, type: "text" }],
                        textDeltaChunkSize: "AGENT_BASE_STREAM_PREFIX".length,
                        textDeltaDelayMs: 500,
                    };
                }
                expect(JSON.stringify(request.context.messages)).toContain(
                    "AGENT_BASE_STREAM_PREFIX",
                );
                expect(JSON.stringify(request.context.messages)).toContain(
                    "Start the Agent Base stream.",
                );
                return {
                    content: [{ text: "AGENT_BASE_SECOND_REPLY", type: "text" }],
                };
            },
            rows: 24,
        });
        running.add(gym);

        gym.terminal.type("Start the Agent Base stream.");
        gym.terminal.press("enter");
        const streaming = await gym.terminal.waitForText("AGENT_BASE_STREAM_PREFIX", 10_000);
        expect(streaming.text).not.toContain("AGENT_BASE_STREAM_END");

        await gym.terminal.waitForText("AGENT_BASE_STREAM_END", 10_000);
        // The second prompt must open its own run, so the first turn settles into history
        // first; submitting while the run is still open would steer into it instead.
        await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("Worked for"),
            "the first turn to settle into history",
            10_000,
        );
        gym.terminal.type("Show that the first turn remains in history.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("AGENT_BASE_SECOND_REPLY", 10_000);
        await expect
            .poll(async () => (await readFinishedRuns(gym)).length, { timeout: 10_000 })
            .toBe(2);
        expect(await readFinishedRuns(gym)).toEqual(["completed", "completed"]);
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("AGENT_BASE_SECOND_REPLY") &&
                snapshot.text.includes("Worked for") &&
                !snapshot.text.includes("esc to interrupt"),
            "the second Agent Base turn to complete",
            10_000,
        );

        const transcript = await captureScrollback(gym);
        expect(count(transcript, "Start the Agent Base stream.")).toBe(1);
        expect(count(transcript, firstAnswer)).toBe(1);
        expect(count(transcript, "AGENT_BASE_SECOND_REPLY")).toBe(1);
        expect(transcript.indexOf("Show that the first turn remains in history.")).toBeLessThan(
            transcript.indexOf("AGENT_BASE_SECOND_REPLY"),
        );
    }, 90_000);
});

function count(value: string, search: string): number {
    return value.split(search).length - 1;
}

/** Reads each settled run's finish reason from the daemon, in run order. */
async function readFinishedRuns(gym: Gym): Promise<string[]> {
    const result = await gym.runInContainer("node", [
        "-e",
        `
const { readFileSync } = require("node:fs");
const { request } = require("node:http");
const { join } = require("node:path");
const directory = join(process.env.HOME, ".happy", "agent");
const token = readFileSync(join(directory, "token"), "utf8").trim();
const socketPath = join(directory, "server.sock");
function call(path) {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers: { authorization: "Bearer " + token }, method: "GET", path, socketPath },
            (response) => {
                let data = "";
                response.on("data", (chunk) => { data += chunk; });
                response.on("end", () => resolve(JSON.parse(data)));
            },
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}
(async () => {
    const bootstrap = await call("/v0/bootstrap/desktop");
    const agents = bootstrap.workspaces.flatMap((workspace) => workspace.agents ?? []);
    const events = await call("/v0/events?limit=10000");
    const finished = events.events.filter(
        (event) => event.type === "run.finished" && event.payload.agentId === agents[0].id,
    );
    console.log(JSON.stringify(finished.map((event) => event.payload.run.reason)));
})().catch((error) => { console.error(error); process.exit(1); });
`,
    ]);
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout) as string[];
}
