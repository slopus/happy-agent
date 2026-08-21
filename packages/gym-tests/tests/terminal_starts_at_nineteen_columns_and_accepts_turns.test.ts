import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal starts at nineteen columns and accepts turns", () => {
    it("renders its first frame at the true narrow size and remains usable", async () => {
        const gym = await createGym({
            cols: 19,
            inference: [
                { content: [{ text: "NARROW_ONE 日本語 👩🏽‍💻", type: "text" }] },
                { content: [{ text: "NARROW_TWO", type: "text" }] },
            ],
            rows: 40,
            startupText: "Ask Happy Terminal",
        });
        running.add(gym);

        const startup = await gym.terminal.snapshot();
        assertHealthyNarrowTerminal(startup);
        const baseline = startup.scroll;

        gym.terminal.type("tiny startup one");
        gym.terminal.press("enter");
        const first = await waitForNarrowText(gym, "NARROW_ONE");
        assertHealthyNarrowTerminal(first);
        expect(first.text).toContain("日本語");
        expect(first.text).toContain("👩🏽‍💻");
        expect(first.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(first.scroll.topArrivalCount).toBe(baseline.topArrivalCount);

        gym.terminal.type("tiny startup two");
        gym.terminal.press("enter");
        const second = await waitForNarrowText(gym, "NARROW_TWO");
        assertHealthyNarrowTerminal(second);
        expect(second.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
        expect(second.scroll.topArrivalCount).toBe(baseline.topArrivalCount);

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(2);
        expect(agentRequests[0]?.context.messages.at(-1)).toMatchObject({
            content: [{ text: "tiny startup one", type: "text" }],
            role: "user",
        });
        expect(agentRequests[1]?.context.messages.at(-1)).toMatchObject({
            content: [{ text: "tiny startup two", type: "text" }],
            role: "user",
        });
    }, 120_000);
});

async function waitForNarrowText(gym: Gym, value: string) {
    return Promise.race([
        gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes(value) &&
                snapshot.text.includes("Ask Happy Terminal") &&
                snapshot.scroll.atBottom,
            `${value} and the narrow idle composer`,
            30_000,
        ),
        gym.exit().then(({ exitCode, signal }) => {
            throw new Error(
                `Happy Terminal exited while waiting for ${value} (code ${exitCode}, signal ${String(signal)}).`,
            );
        }),
    ]);
}

function assertHealthyNarrowTerminal(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
): void {
    expect(snapshot.rows).toHaveLength(40);
    expect(snapshot.rows.every((row) => visibleWidth(row) <= 19)).toBe(true);
    expect(snapshot.scroll).toMatchObject({ atBottom: true, visibleRows: 40 });
    expect(snapshot.cursor.x).toBeLessThan(19);
    expect(snapshot.cursor.y).toBeLessThan(40);
    expect(snapshot.title).toContain("Happy Terminal");
    expect(snapshot.text).toContain("Ask Happy Terminal");
    expect(snapshot.text).toContain("gym off");
    expect(snapshot.text).not.toContain("\x1b[200~");
    expect(snapshot.text).not.toContain("\x1b[201~");
    expect(snapshot.text).not.toContain("�");
}
