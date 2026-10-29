import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("keeps the name the person gave new work when its first message arrives", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const stem = await h.create();
        const taskId = stem.space.target.id;
        const { task } = await h.gym.client.getTask(taskId);
        await h.gym.client.renameTask(
            taskId,
            { name: "Pricing rewrite" },
            { ifMatch: task.version },
        );

        await h.gym.send("Rewrite the pricing page copy so the team plan is clear.", {
            sessionId: stem.agent.id,
        });
        // Prioritizing hears about the first message only after it was accepted, which is when
        // naming would have started.
        await h.gym.waitUntil(
            () =>
                h.gym.inference.requests.some(
                    (request) =>
                        request.instructions.includes("You are the Focus Agent") &&
                        JSON.stringify(request.messages).includes(stem.space.id),
                )
                    ? true
                    : undefined,
            "the new-work brief",
        );

        expect(
            h.gym.inference.requests.some((request) =>
                request.instructions.includes("You name a piece of work"),
            ),
        ).toBe(false);
        expect((await h.gym.client.getTask(taskId)).task.name).toBe("Pricing rewrite");
        expect((await h.read()).spaces.find((space) => space.id === stem.space.id)?.title).toBe(
            "Pricing rewrite",
        );
        expect(h.gym.errors).toEqual([]);
    } finally {
        await h.gym.dispose();
    }
}, 60_000);

it("lets the person name sections freely and keeps Prioritizing from renaming them", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const put = async (html: string, mutationId: string) => {
            const doc = await h.read();
            return await h.gym.http.ok<{ version: number; html: string }>(
                "PUT",
                "/v0/spaces/sidebar",
                { html, baseVersion: doc.version, mutationId },
            );
        };
        // Labels Prioritizing may not write are the person's to choose, duplicates included.
        let current = await h.read();
        const named = current.html.replace(
            "</nav>",
            '  <happy-section id="later" label="Older stuff"/>\n  <happy-section id="again" label="tasks"/>\n</nav>',
        );
        expect((await put(named, "person-names-sections")).html).toBe(named);

        // Renaming a section the person named is refused for Prioritizing.
        current = await h.read();
        const relabelled = await h.edit(
            current.html.replace('label="Older stuff"', 'label="Reading list"'),
        );
        expect(relabelled.text).toContain("Keep the person's name for this section.");
        expect((await h.read()).html).toContain('label="Older stuff"');
        expect(h.gym.errors).toEqual([]);
    } finally {
        await h.gym.dispose();
    }
}, 60_000);
