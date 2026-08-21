import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("tiny terminal under twenty columns remains usable", () => {
    it("keeps rendering and accepting turns after a resize to nineteen columns", async () => {
        const gym = await createGym({
            cols: 60,
            inference: [
                { content: [{ text: "TINY_OK_1", type: "text" }] },
                { content: [{ text: "TINY_OK_2", type: "text" }] },
            ],
            rows: 40,
        });
        running.add(gym);

        gym.terminal.resize(19, 40);
        await gym.terminal.waitUntil(
            (snapshot) => snapshot.rows.length === 40 && snapshot.scroll.visibleRows === 40,
            "nineteen-column viewport",
        );

        gym.terminal.type("first tiny turn");
        gym.terminal.press("enter");
        const first = await waitForTextWhileRunning(gym, "TINY_OK_1");
        assertHealthyTinyTerminal(first);

        gym.terminal.type("second tiny turn");
        gym.terminal.press("enter");
        const second = await waitForTextWhileRunning(gym, "TINY_OK_2");
        assertHealthyTinyTerminal(second);

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(2);
        expect(agentRequests[1]?.context.messages.at(-1)).toMatchObject({
            content: [{ text: "second tiny turn", type: "text" }],
            role: "user",
        });
    }, 120_000);
});

async function waitForTextWhileRunning(gym: Gym, value: string) {
    return Promise.race([
        gym.terminal.waitForText(value, 30_000),
        gym.exit().then(({ exitCode, signal }) => {
            throw new Error(
                `Happy Terminal exited while waiting for ${value} (code ${exitCode}, signal ${String(signal)}).`,
            );
        }),
    ]);
}

function assertHealthyTinyTerminal(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
): void {
    expect(snapshot.rows).toHaveLength(40);
    expect(snapshot.rows.every((row) => [...row].length <= 19)).toBe(true);
    expect(snapshot.scroll).toMatchObject({ atBottom: true, visibleRows: 40 });
    expect(snapshot.cursor.x).toBeLessThan(19);
    expect(snapshot.cursor.y).toBeLessThan(40);
    expect(snapshot.title).toContain("Happy Terminal");
    expect(snapshot.text).toContain("Ask Happy Terminal");
    expect(snapshot.text).toContain("gym off");
    expect(snapshot.text).not.toContain("�");
}
