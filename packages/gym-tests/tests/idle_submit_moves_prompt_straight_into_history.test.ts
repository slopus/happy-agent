import { describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

type TerminalSnapshot = Awaited<ReturnType<Gym["terminal"]["snapshot"]>>;

// Skill discovery reads every SKILL.md sequentially. A realistic skill tree makes that scan
// long enough to paint, which is exactly what a person with installed skills experiences.
const createSkillFiles = (count: number) =>
    Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
            `.agents/skills/gym-skill-${String(index).padStart(4, "0")}/SKILL.md`,
            `---\nname: gym-skill-${String(index).padStart(4, "0")}\ndescription: A gym fixture skill used to make skill discovery observable.\n---\n\nFixture skill body.\n`,
        ]),
    );

const skillFiles = createSkillFiles(120);

describe("idle submit", () => {
    it("keeps the submitted prompt in history instead of flashing it as queued work", async () => {
        const prompt =
            "IDLE_SUBMIT_PROMPT that is deliberately long so the intermediate row is easy to see on screen";
        const gym = await createGym({
            cols: 88,
            files: skillFiles,
            inference: [
                {
                    completionDelayMs: 1_000,
                    content: [{ text: "IDLE_SUBMIT_COMPLETE", type: "text" }],
                },
            ],
            rows: 24,
        });

        try {
            await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

            gym.terminal.type(prompt);
            await gym.terminal.waitUntil(
                (snapshot) => snapshot.text.includes("IDLE_SUBMIT_PROMPT"),
                "the typed prompt in the composer",
                30_000,
            );

            // Every painted frame from the submit onward is inspected. Polling alone cannot
            // observe an intermediate frame the terminal has already replaced.
            const framePromises: Promise<TerminalSnapshot>[] = [];
            const stopCapturing = gym.terminal.onOutput(() => {
                framePromises.push(gym.terminal.snapshot());
            });
            gym.terminal.press("enter");

            const completed = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("IDLE_SUBMIT_COMPLETE") &&
                    snapshot.rows.some((row) => row.includes(`› IDLE_SUBMIT_PROMPT`)) &&
                    !snapshot.text.includes("esc to interrupt"),
                "the submitted prompt in history and the completed run",
                30_000,
            );
            stopCapturing();

            const frames = await Promise.all(framePromises);
            expect(frames.length).toBeGreaterThan(0);

            for (const frame of frames) {
                // An idle submit owns its transcript row immediately. Showing it as queued work
                // first makes the text appear below the transcript and then jump away.
                expect(frame.rows.filter((row) => row.includes("↳ queued"))).toEqual([]);
                // The text must never leave the screen between the composer and history.
                expect(frame.text.includes("IDLE_SUBMIT_PROMPT")).toBe(true);
            }

            expect(completed.text.split("\n").filter((row) => row.includes("↳ queued"))).toEqual(
                [],
            );
            expect(
                completed.rows.filter((row) => row.includes(`› IDLE_SUBMIT_PROMPT`)),
            ).toHaveLength(1);
            expect(completed.scroll.atBottom).toBe(true);
        } finally {
            await gym.dispose();
        }
    }, 120_000);

    it("takes the optimistic row back out of history when the prompt is bounced", async () => {
        const prompt = "BOUNCED_PROMPT must return to the composer";
        // A large skill tree keeps the turn in startup long enough to interrupt it before the
        // prompt reaches inference, which is the window where the optimistic row can be undone.
        const gym = await createGym({
            cols: 88,
            files: createSkillFiles(4_000),
            inference: [{ content: [{ text: "BOUNCE_UNREACHED", type: "text" }] }],
            rows: 24,
        });

        try {
            await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);

            gym.terminal.type(prompt);
            await gym.terminal.waitForText(`› ${prompt}`, 30_000);
            gym.terminal.press("enter");

            // The row is claimed the instant the prompt is submitted, before any inference.
            await gym.terminal.waitUntil(
                (snapshot) => snapshot.text.includes("esc to interrupt"),
                "the turn entering startup with the prompt already in history",
                30_000,
            );

            gym.terminal.press("escape");
            // The prompt is already drawn in history, so its presence proves nothing. The bounce
            // is complete once the run has stopped and the composer is no longer showing its
            // placeholder, meaning the text was handed back for editing.
            const bounced = await gym.terminal.waitUntil(
                (snapshot) =>
                    !snapshot.text.includes("esc to interrupt") &&
                    !snapshot.text.includes("Ask Happy Terminal to do anything"),
                "the interrupted turn handing the prompt back to the composer",
                30_000,
            );

            // History rows and the composer share the same "› " prefix, so the prompt must
            // appear exactly once. A second copy is the claimed row stranded in history as a
            // user message that was never sent.
            expect(bounced.rows.filter((row) => row.includes(`› ${prompt}`))).toHaveLength(1);
            expect(bounced.text).not.toContain("↳ queued");
            expect(gym.inference.requests.filter((request) => !isTitleRequest(request))).toEqual(
                [],
            );
        } finally {
            await gym.dispose();
        }
    }, 120_000);
});

function isTitleRequest(request: { options: { sessionId?: string } }): boolean {
    return request.options.sessionId?.endsWith(":title") === true;
}
