import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;

it("lets the person drag stem cells anywhere and keeps Prioritizing off them, before and after the first message", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const happy = (await h.read()).spaces.find((space) => space.title === "Happy")!;
        const first = await h.create();
        const second = await h.create();
        let current = await h.read();
        // New work lands right below Happy, newest first.
        expect(current.html).toContain(
            `${line(happy.id)}${line(second.space.id)}${line(first.space.id)}`,
        );

        const put = async (html: string, mutationId: string) => {
            const doc = await h.read();
            return await h.gym.http.ok<{ version: number; html: string }>(
                "PUT",
                "/v0/spaces/sidebar",
                { html, baseVersion: doc.version, mutationId },
            );
        };

        // Between stem cells: swap the two.
        current = await h.read();
        const swapped = current.html.replace(
            `${line(second.space.id)}${line(first.space.id)}`,
            `${line(first.space.id)}${line(second.space.id)}`,
        );
        expect((await put(swapped, "swap-stem-cells")).html).toBe(swapped);

        // Past Happy, to the very top of the rows.
        current = await h.read();
        const aboveHappy = current.html
            .replace(line(second.space.id), "")
            .replace(line(happy.id), `${line(second.space.id)}${line(happy.id)}`);
        expect((await put(aboveHappy, "stem-cell-above-happy")).html).toBe(aboveHappy);

        // Into a section of the person's own.
        current = await h.read();
        const intoSection = current.html
            .replace(line(first.space.id), "")
            .replace(
                "</nav>",
                `  <happy-section id="ideas" label="Ideas"/>\n${line(first.space.id)}</nav>`,
            );
        const placed = await put(intoSection, "stem-cell-into-section");
        expect(placed.html).toBe(intoSection);

        const listed = JSON.parse((await h.call("list_sidebar", {})).text) as {
            manualIds: string[];
        };
        expect(listed.manualIds).toEqual(expect.arrayContaining([first.space.id, second.space.id]));

        // After the first message Prioritizing is told the person already placed it, and it may not
        // move it back.
        await h.gym.send("Sketch the onboarding flow.", { sessionId: first.agent.id });
        await h.gym.waitUntil(
            () =>
                h.gym.inference.requests.some(
                    (request) =>
                        request.instructions.includes("You are the Focus Agent") &&
                        JSON.stringify(request.messages).includes(
                            "The person already placed it. Choose its icon now",
                        ),
                )
                    ? true
                    : undefined,
            "the new-work brief",
        );
        const row = (
            JSON.parse((await h.call("list_sidebar", {})).text) as {
                spaces: { id: string; placedByPerson?: true; newWork?: string }[];
            }
        ).spaces.find((space) => space.id === first.space.id)!;
        expect(row.placedByPerson).toBe(true);
        expect(row.newWork).toBeUndefined();
        current = await h.read();
        const movedBack = current.html
            .replace(line(first.space.id), "")
            .replace(line(happy.id), `${line(happy.id)}${line(first.space.id)}`);
        expect((await h.edit(movedBack)).text).toContain("manual placement");
        expect((await h.read()).version).toBe(current.version);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
