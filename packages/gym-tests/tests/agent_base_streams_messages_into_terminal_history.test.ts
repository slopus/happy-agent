import { afterEach, describe, expect, it } from "vitest";

import { captureScrollback, createGym, type Gym } from "@slopus/rig-gym";

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
        gym.terminal.type("Show that the first turn remains in history.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("AGENT_BASE_SECOND_REPLY", 10_000);
        await expect
            .poll(async () => await readEventTypes(gym), { timeout: 10_000 })
            .toContain("run_finished");
        expect(
            (await readEventTypes(gym)).filter(
                (type) => type === "run_finished" || type === "run_error",
            ),
        ).toHaveLength(1);
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

async function readEventTypes(gym: Gym): Promise<string[]> {
    const result = await gym.runInContainer("sqlite3", [
        "-json",
        "/home/rig/.server/agent-sessions.sqlite",
        "SELECT type FROM session_events WHERE session_id = " +
            "(SELECT id FROM sessions WHERE parent_session_id IS NULL " +
            "ORDER BY created_at_ms DESC LIMIT 1) ORDER BY seq",
    ]);
    expect(result.stderr).toBe("");
    return (JSON.parse(result.stdout) as Array<{ type: string }>).map(({ type }) => type);
}
