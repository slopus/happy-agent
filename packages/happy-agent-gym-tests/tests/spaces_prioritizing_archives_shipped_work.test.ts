import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("lets Prioritizing archive a task whose work shipped, and only task rows", async () => {
    const h = await sidebarGym();
    try {
        const seeded = await h.read();
        const happy = seeded.spaces.find((space) => space.title === "Happy")!;
        const cell = await h.create();
        await h.gym.send("Ship the release.", { sessionId: cell.agent.id });

        // A bot's row has no task behind it to archive.
        expect(
            (
                await h.call("archive_shipped_task", {
                    spaceId: happy.id,
                    shipped: "Nothing.",
                })
            ).text,
        ).toContain("Only task rows can be archived.");

        const archived = await h.call("archive_shipped_task", {
            spaceId: cell.space.id,
            shipped: "The release is on main.",
        });
        expect(archived.text).toContain("Archived");
        expect((await h.gym.client.getTask(cell.space.target.id)).task.status).toBe("archived");
        await h.gym.waitUntil(
            async () => ((await h.read()).html.includes(cell.space.id) ? undefined : true),
            "the archived task's row leaving the sidebar",
        );
    } finally {
        await h.gym.dispose();
    }
}, 120000);
