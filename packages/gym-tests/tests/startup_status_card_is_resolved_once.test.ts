import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym, type TerminalSnapshot } from "@slopus/happy-terminal-gym";

const ARTIFACTS = resolve(import.meta.dirname, "../../artifacts/startup-status-card");
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("resolved startup status card", () => {
    it("renders fresh and resumed wide sessions once before transcript history", async () => {
        const gym = await createResumingGym(96, 42, "WIDE_RESUME_BOUNDARY");
        running.add(gym);

        const fresh = await gym.terminal.snapshot();
        assertWideCard(fresh, "New session");
        expect(fresh.text).not.toContain("system Ready.");
        await screenshot(gym, "fresh-wide.png");

        await recordTranscript(gym);
        gym.terminal.press("ctrlD");
        const resumed = await gym.terminal.waitUntil(
            (snapshot) => {
                const boundary = snapshot.text.indexOf("WIDE_RESUME_BOUNDARY");
                return boundary >= 0 && snapshot.text.slice(boundary).includes("Resumed");
            },
            "the resolved resumed status card",
            30_000,
        );
        const resumedText = resumed.text.slice(resumed.text.indexOf("WIDE_RESUME_BOUNDARY"));
        expect(countOccurrences(resumedText, "Resumed")).toBe(1);
        expect(resumedText).not.toContain("New session");
        expect(resumedText.indexOf("Resumed")).toBeLessThan(resumedText.indexOf("REPLAY_HISTORY"));
        assertWideCard({ ...resumed, text: resumedText }, "Resumed");
        await screenshot(gym, "resumed-wide.png");
    }, 120_000);

    it("preserves useful fresh and resumed values at nineteen columns", async () => {
        const gym = await createResumingGym(19, 40, "R19");
        running.add(gym);

        const fresh = await gym.terminal.snapshot();
        assertNarrowCard(fresh, "New session");
        await screenshot(gym, "fresh-19-columns.png");

        await recordTranscript(gym);
        gym.terminal.press("ctrlD");
        const resumed = await gym.terminal.waitUntil(
            (snapshot) => {
                const boundary = snapshot.text.indexOf("R19");
                return boundary >= 0 && snapshot.text.slice(boundary).includes("Resumed");
            },
            "the nineteen-column resumed status card",
            30_000,
        );
        const resumedText = resumed.text.slice(resumed.text.indexOf("R19"));
        assertNarrowCard({ ...resumed, text: resumedText }, "Resumed");
        expect(countOccurrences(resumedText, "Resumed")).toBe(1);
        expect(resumedText.indexOf("Resumed")).toBeLessThan(resumedText.indexOf("REPLAY_HISTORY"));
        await screenshot(gym, "resumed-19-columns.png");
    }, 120_000);

    it("keeps one status card when the resolved terminal is resized", async () => {
        const gym = await createGym({ cols: 96, inference: [], rows: 40 });
        running.add(gym);
        assertWideCard(await gym.terminal.snapshot(), "New session");

        gym.terminal.resize(19, 40);
        const narrow = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.rows.every((row) => visibleWidth(row) <= 19) &&
                snapshot.text.includes("New session") &&
                snapshot.text.includes("Ask Happy Terminal"),
            "one responsive status card after resize",
            30_000,
        );
        assertNarrowCard(narrow, "New session");
        expect(countOccurrences(narrow.text, "New session")).toBe(1);
        await screenshot(gym, "resized-once-19-columns.png");
    }, 120_000);
});

async function createResumingGym(cols: number, rows: number, marker: string): Promise<Gym> {
    return createGym({
        cols,
        mode: "docker",
        entrypoint: [
            "bash",
            "-lc",
            `node /app/packages/happy-terminal/dist/main.js; echo ${marker}; exec node /app/packages/happy-terminal/dist/main.js resume --last`,
        ],
        inference: [{ content: [{ text: "REPLAY_HISTORY", type: "text" }] }],
        rows,
        ...(cols === 19 ? { startupText: "Ask Happy Terminal" } : {}),
    });
}

async function recordTranscript(gym: Gym): Promise<void> {
    gym.terminal.type("Keep one turn for resume replay.");
    gym.terminal.press("enter");
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.text.includes("REPLAY_HISTORY") &&
            snapshot.text.includes("Ask Happy Terminal"),
        "the transcript marker and idle composer",
        30_000,
    );
}

function assertWideCard(snapshot: TerminalSnapshot, sessionLabel: string): void {
    expect(snapshot.text).toContain(sessionLabel);
    expect(snapshot.text).toContain("Model: Gym");
    expect(snapshot.text).toContain("Reasoning: Off");
    expect(snapshot.text).toContain("Provider: Gym");
    expect(snapshot.text).toContain("Workspace: /workspace");
    expect(snapshot.text).toContain("Environment: Local");
    expect(snapshot.text).toContain("Access: Full access");
    expect(snapshot.text).not.toContain("Fast");
    expect(snapshot.rows.every((row) => visibleWidth(row) <= 96)).toBe(true);
}

function assertNarrowCard(snapshot: TerminalSnapshot, sessionLabel: string): void {
    expect(snapshot.text).toContain(sessionLabel);
    expect(snapshot.text).toContain("Gym");
    expect(snapshot.text).toContain("/workspace");
    expect(snapshot.text).toContain("Local");
    expect(snapshot.text).toContain("Full access");
    expect(snapshot.text).not.toContain("Ready.");
    expect(snapshot.rows.every((row) => visibleWidth(row) <= 19)).toBe(true);
    expect(snapshot.text).not.toContain("�");
}

function countOccurrences(value: string, needle: string): number {
    return value.split(needle).length - 1;
}

async function screenshot(gym: Gym, name: string): Promise<void> {
    await mkdir(ARTIFACTS, { recursive: true });
    await gym.terminal.screenshot(resolve(ARTIFACTS, name));
}
