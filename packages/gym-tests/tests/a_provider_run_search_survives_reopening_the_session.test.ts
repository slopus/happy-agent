import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const rig = "node /app/packages/rig/dist/main.js";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * Reopening a session rebuilds the transcript from what was durably kept, not from the events a
 * live client saw. A provider-run call is deliberately absent from the assistant message — Rig
 * never executes one — so unless it is kept in its own right, every record that the provider
 * searched vanishes the moment the session is closed, leaving an answer citing sources it has no
 * visible reason to know.
 */
describe("a provider-run search in a reopened session", () => {
    it("is still in the transcript after the session is closed and resumed", async () => {
        const gym = await createGym({
            cols: 96,
            entrypoint: [
                "bash",
                "-lc",
                `${rig}; echo SEARCH_SESSION_REOPENED; exec ${rig} resume --last`,
            ],
            inference: [
                {
                    content: [{ text: "People are praising it.", type: "text" }],
                    serverToolCalls: [
                        {
                            arguments: '{"query":"Claude Code","limit":"5","mode":"Latest"}',
                            callId: "x-keyword-1",
                            name: "x_keyword_search",
                        },
                    ],
                },
                { content: [{ text: "Nothing more to add.", type: "text" }] },
            ],
            mode: "docker",
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("What is X saying about Claude Code?");
        gym.terminal.press("enter");
        const answered = await gym.terminal.waitForText("People are praising it.", 30_000);
        expect(answered.text).toContain('Searched X for "Claude Code"');

        gym.terminal.press("ctrlC");
        gym.terminal.press("ctrlC");
        await gym.terminal.waitForText("SEARCH_SESSION_REOPENED", 30_000);

        // The rebuilt transcript, from durable state alone. Everything the first process drew is
        // still in scrollback, so what proves the point is the answer printed *after* the marker
        // the restart wrote — that copy can only have come from the rebuild.
        const afterMarker = (text: string): string =>
            text.slice(text.lastIndexOf("SEARCH_SESSION_REOPENED"));
        const reopened = await gym.terminal.waitUntil(
            (snapshot) => afterMarker(snapshot.text).includes("People are praising it."),
            "the resumed session to redraw its transcript",
            30_000,
        );
        const rebuilt = afterMarker(reopened.text);
        expect(rebuilt).toContain('Searched X for "Claude Code"');
        expect(rebuilt).not.toContain("x_keyword_search");
        expect(rebuilt).not.toContain('{"query"');
    }, 180_000);
});
