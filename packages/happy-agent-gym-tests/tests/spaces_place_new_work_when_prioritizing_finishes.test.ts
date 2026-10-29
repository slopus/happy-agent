import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

it("applies one factual batch when Prioritizing finishes while legacy row actions stay independent", async () => {
    const h = await sidebarGym();
    try {
        const legacy = await h.gym.http.ok<{
            spaces: { id: string; target: { agentId: string } }[];
            sections: unknown[];
        }>("GET", "/v0/spaces");
        const happy = legacy.spaces[0]!;
        // Happy's only subtask is Focus, which the tidy that opened this sidebar started.
        expect(
            (await h.gym.client.getAgent(happy.target.agentId)).agent.subtasks?.map(
                (subtask) => subtask.title,
            ),
        ).toEqual(["Focus"]);
        await h.read();
        const created = await h.create();
        await h.gym.send("Plan this release.", { sessionId: created.agent.id });
        // The first message wakes Prioritizing, and that notice ends the classic-sidebar seed.
        const current = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.seed === undefined ? doc : undefined;
        }, "the new-work notice");
        const node = `  <happy-space id="${created.space.id}"/>
`;
        const placed = current.html.replace(node, "").replace(
            "</nav>",
            `  <happy-section id="release" label="Releases"/>
${node}</nav>`,
        );
        // The scenario asks in Prioritizing's conversation, so a new section needs no proposal.
        expect((await h.edit(placed)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === placed ? true : undefined),
            "the placement",
        );
        const batches = await h.gym.http.ok<{ batches: { note: string; noteMessageId: string }[] }>(
            "GET",
            "/v0/spaces/batches",
        );
        expect(batches.batches).toHaveLength(1);
        expect(batches.batches[0]!.note).toMatch(/^Put .+ in Releases\.$/);
        const messages = async (agentId: string) =>
            (
                await h.gym.http.ok<{ runs: { messages: { id: string }[] }[] }>(
                    "GET",
                    `/v0/agents/${agentId}/messages`,
                )
            ).runs.flatMap((run) => run.messages);
        // The note is Prioritizing's own; Happy's chat hears nothing.
        expect((await messages(await h.manager())).map((note) => note.id)).toContain(
            batches.batches[0]!.noteMessageId,
        );
        expect(await messages(happy.target.agentId)).toEqual([]);
        const snapshot = await h.gym.http.ok<typeof legacy>("GET", "/v0/spaces");
        expect(snapshot.sections).toEqual(legacy.sections);
        await h.gym.http.ok("PATCH", `/v0/spaces/${created.space.id}`, { visibility: "folded" });
        expect((await h.read()).html).toBe(placed);
        await h.gym.http.ok("PATCH", `/v0/spaces/${created.space.id}`, { visibility: "shown" });
        expect((await h.gym.http.patch(`/v0/spaces/${happy.id}`, {})).status).toBe(400);
        expect(
            (await h.gym.http.patch(`/v0/spaces/${created.space.id}`, { removed: true })).status,
        ).toBe(409);
        expect(
            (await h.gym.http.patch(`/v0/spaces/${happy.id}`, { afterId: happy.id })).status,
        ).toBe(409);
        const tools = h.gym.inference.requests
            .findLast((request) => request.instructions.includes("You are the Focus Agent"))!
            .tools.map((tool) => tool.name)
            .sort();
        expect(tools).toEqual([
            "archive_shipped_task",
            "edit_sidebar",
            "get_sidebar_styles",
            "join_task",
            "list_sidebar",
            "propose_sidebar",
            "read_artifact",
            "read_artifact_file",
            "read_conversations",
            "set_space_icon",
            "update_artifact",
        ]);
    } finally {
        await h.gym.dispose();
    }
}, 120000);
