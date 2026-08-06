import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * Interrupting a turn while the provider is searching stops Rig reading the answer. It does not
 * stop the search: that already reached the provider's own backend, where Rig has no reach at all.
 *
 * So the live row cannot simply disappear. Its completion is what used to become history, and
 * without one the whole record that a search happened went with the interrupted turn — the same
 * turn whose answer never arrived, leaving nothing to explain why.
 */
describe("a provider-run search interrupted mid-flight", () => {
    it("becomes a history row saying Rig stopped, not that the search did", async () => {
        const gym = await createGym({
            cols: 96,
            inference: [
                {
                    content: [{ text: "People are praising it.", type: "text" }],
                    serverToolCallDeltaDelayMs: 200,
                    // Long enough that the search is unambiguously still open when esc arrives.
                    serverToolCallEndDelayMs: 60_000,
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
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("What is X saying about Claude Code?");
        gym.terminal.press("enter");

        const searching = await gym.terminal.waitForText('Searching X for "Claude Code"', 30_000);
        expect(searching.text).toContain("esc to interrupt");

        gym.terminal.press("escape");

        const stopped = await gym.terminal.waitForText("Stopped while searching X", 30_000);
        // What it was searching for survives the interruption; a row with no subject would tell
        // the reader nothing about what reached the network.
        expect(stopped.text).toContain('for "Claude Code"');
        // The live row gave its height to history rather than collapsing out of the transcript.
        expect(stopped.text).not.toContain('Searching X for "Claude Code"');
        expect(stopped.text).not.toContain("x_keyword_search");
        expect(stopped.text).not.toContain('{"query"');
        // The answer never arrived, which is exactly why the search has to be accounted for.
        expect(stopped.text).not.toContain("People are praising it.");

        // The record is history now, so the next turn cannot take it away.
        gym.terminal.type("Anything else?");
        gym.terminal.press("enter");
        const finished = await gym.terminal.waitForText("Nothing more to add.", 30_000);
        expect(finished.text).toContain("Stopped while searching X");
        expect(finished.text).not.toContain("Unknown tool");
    }, 180_000);
});
