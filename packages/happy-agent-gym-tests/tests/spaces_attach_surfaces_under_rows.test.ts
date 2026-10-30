import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

import { sidebarGym } from "./support/sidebarGym.js";

type Gym = Awaited<ReturnType<typeof sidebarGym>>;

/** Starts new work whose conversation has had its first message. */
async function work(h: Gym, text: string) {
    const cell = await h.create();
    await h.gym.send(text, { sessionId: cell.agent.id });
    return cell;
}

/** The row's space ID for a Surface, once Spaces has one. */
async function surfaceRow(h: Gym, surfaceId: string) {
    return await h.gym.waitUntil(
        async () => (await h.read()).spaces.find((space) => space.target.id === surfaceId)?.id,
        "the Surface's row",
    );
}

async function subtaskOf(h: Gym, agentId: string, title: string) {
    const created = await h.call(
        "create_subtask",
        {
            title,
            text: `${title}.`,
            model: h.gym.selection.modelId,
            effort: h.gym.selection.effort,
            provider: h.gym.selection.providerId,
        },
        agentId,
    );
    return /Created subtask ([a-z0-9]+)/.exec(created.text)![1]!;
}

it("lets new work make a todo list that appears under its own row, and lifts it out when the work is archived", async () => {
    const h = await sidebarGym();
    try {
        expect((await h.gym.client.getHealth()).capabilities).toMatchObject({
            sidebarAttachments: true,
        });
        await h.read();
        const cell = await work(h, "Plan the Android 2.5 release.");
        const other = await work(h, "Rewrite the pricing page.");
        // The person's conversations are offered the tool once Stem Cells is on.
        await h.gym.waitUntil(
            () =>
                h.gym.inference.requests.some(
                    (request) =>
                        request.sessionId === cell.agent.id &&
                        request.tools.some((tool) => tool.name === "attach_to_my_row"),
                ) || undefined,
            "the attach tool offered to new work",
        );

        const made = await h.call(
            "attach_to_my_row",
            { create: { kind: "todo", name: "Release checklist" } },
            cell.agent.id,
        );
        expect(made.text).toContain('Attached "Release checklist"');
        const surfaceId = /Surface ([a-z0-9]{24}) \(todo\)/.exec(made.text)![1]!;
        expect(made.text).toContain(`[Release checklist](happy://surfaces/${surfaceId})`);
        const todoRow = await surfaceRow(h, surfaceId);
        const attached = await h.read();
        // Under the row, expanded, and nowhere else, though the list is still empty.
        expect(attached.html).toContain(
            `  <happy-space id="${cell.space.id}" expanded="true">\n    <happy-space id="${todoRow}"/>\n  </happy-space>\n`,
        );
        expect(attached.html.split(`id="${todoRow}"`)).toHaveLength(2);
        const surfaces = (await h.gym.client.listSurfaces()).surfaces;
        expect(surfaces.find((surface) => surface.id === surfaceId)).toMatchObject({
            type: "todo",
            name: "Release checklist",
            members: [expect.objectContaining({ userId: null })],
        });

        // Attaching it under other work moves it; it is never shown twice.
        const moved = await h.call("attach_to_my_row", { surfaceId }, other.agent.id);
        expect(moved.text).toContain('Attached "Release checklist"');
        const elsewhere = await h.read();
        expect(elsewhere.html).toContain(
            `  <happy-space id="${other.space.id}" expanded="true">\n    <happy-space id="${todoRow}"/>\n  </happy-space>\n`,
        );
        expect(elsewhere.html).toContain(
            `  <happy-space id="${cell.space.id}" expanded="true"/>\n`,
        );

        // Archiving the work that holds it puts the list back at the top level in its place.
        const { task } = await h.gym.client.getTask(other.space.target.id);
        await h.gym.client.archiveTask(task.id, { ifMatch: task.version });
        await h.gym.waitUntil(
            async () =>
                (await h.read()).html.includes(`  <happy-space id="${todoRow}"/>\n`) &&
                !(await h.read()).html.includes(other.space.id)
                    ? true
                    : undefined,
            "the list lifted out of the archived work",
        );
        expect(h.gym.errors).toEqual([]);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);

it("lets Prioritizing attach an existing chat under its work, and never puts back what the person drags out", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const cell = await work(h, "Plan the launch with Steve.");
        const { surface: chat } = await h.gym.client.createSurface({
            type: "chat",
            name: "Launch with Steve",
        });
        // A chat has a row on membership alone.
        const chatRow = await surfaceRow(h, chat.id);
        const before = await h.read();
        expect(before.html).toContain(`  <happy-space id="${chatRow}"/>\n`);

        const nested = before.html
            .replace(`  <happy-space id="${chatRow}"/>\n`, "")
            .replace(
                `  <happy-space id="${cell.space.id}"/>\n`,
                `  <happy-space id="${cell.space.id}" expanded="true">\n    <happy-space id="${chatRow}"/>\n  </happy-space>\n`,
            );
        expect((await h.edit(nested)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).html === nested ? true : undefined),
            "the chat under the launch work",
        );

        // The person drags the chat out; the change applies as a move, never a removal.
        const current = await h.read();
        const dragged = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "drag-chat-out",
            baseVersion: current.version,
            operations: [{ type: "remove", id: chatRow }],
        });
        expect(dragged.operations).toEqual([
            { type: "move", id: chatRow, to: { after: cell.space.id } },
        ]);
        expect(dragged.html).toContain(`  <happy-space id="${chatRow}"/>\n`);

        // Neither Prioritizing nor the work's own conversation moves it back.
        expect((await h.edit(nested)).text).toContain("manual placement");
        const again = await h.call("attach_to_my_row", { surfaceId: chat.id }, cell.agent.id);
        expect(again.text).toContain("stays where it is");
        expect((await h.read()).html).toBe(dragged.html);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);

it("keeps sessions under their own parent and keeps a person's reveal in view", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const release = await work(h, "Ship the release.");
        const pricing = await work(h, "Rewrite pricing.");
        const subtask = await subtaskOf(h, release.agent.id, "Fix tests");
        const second = await subtaskOf(h, release.agent.id, "Write notes");
        const start = await h.read();

        // A session is never placed under another row, by any writer.
        const misplaced = await h.gym.http.request("POST", "/v0/spaces/sidebar/operations", {
            mutationId: "session-elsewhere",
            baseVersion: start.version,
            operations: [
                {
                    type: "insert",
                    node: { type: "space", id: subtask },
                    to: { parent: pricing.space.id },
                },
            ],
        });
        expect(misplaced.status).toBe(400);
        const underPricing = start.html.replace(
            `  <happy-space id="${pricing.space.id}"/>\n`,
            `  <happy-space id="${pricing.space.id}">\n    <happy-space id="${subtask}"/>\n  </happy-space>\n`,
        );
        const put = await h.gym.http.request("PUT", "/v0/spaces/sidebar", {
            html: underPricing,
            baseVersion: start.version,
            mutationId: "session-elsewhere-put",
        });
        expect(put.status).toBe(400);
        expect((await h.edit(underPricing)).text).toContain("not a session");
        expect(
            (await h.call("attach_to_my_row", { spaceId: subtask }, pricing.agent.id)).text,
        ).toMatch(/not in this person's sidebar/);

        // The person reveals every session of the release.
        const revealed = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "reveal-release",
            baseVersion: start.version,
            operations: [
                {
                    type: "insert",
                    node: { type: "space", id: subtask },
                    to: { parent: release.space.id },
                },
                { type: "insert", node: { type: "space", id: second }, to: { after: subtask } },
                { type: "set", id: release.space.id, expanded: true },
            ],
        });
        expect(revealed.html).toContain(
            `  <happy-space id="${release.space.id}" expanded="true">\n    <happy-space id="${subtask}"/>\n    <happy-space id="${second}"/>\n  </happy-space>\n`,
        );
        // Moving a revealed session to another row is refused too.
        const move = await h.gym.http.request("POST", "/v0/spaces/sidebar/operations", {
            mutationId: "move-session",
            baseVersion: revealed.version,
            operations: [{ type: "move", id: subtask, to: { parent: pricing.space.id } }],
        });
        expect(move.status).toBe(400);

        // Prioritizing cannot hide what the person revealed.
        const hidden = revealed.html
            .replace(`    <happy-space id="${second}"/>\n`, "")
            .replace(`id="${release.space.id}" expanded="true"`, `id="${release.space.id}"`);
        const refused = (await h.edit(hidden)).text;
        expect(refused).toContain("Nothing was queued");
        expect(refused).toContain("manual placement");
        expect(refused).toContain("own folds");
        expect((await h.read()).html).toBe(revealed.html);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);

it("offers nothing new to a person who has not turned on Stem Cells", async () => {
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    try {
        await gym.http.ok("GET", "/v0/spaces/sidebar");
        const cell = await gym.http.ok<{ agent: { id: string } }>(
            "POST",
            "/v0/spaces/stem-cells",
            {},
        );
        await gym.send("Make me a todo list for this.", { sessionId: cell.agent.id });
        const { task } = await gym.client.createTask({ name: "Pricing rewrite" });
        await gym.send("Rewrite the pricing page copy.", { sessionId: task.agent.id });
        const requests = gym.inference.requests.filter(
            (request) => request.sessionId === cell.agent.id || request.sessionId === task.agent.id,
        );
        expect(requests.length).toBeGreaterThan(0);
        expect(
            requests.some((request) =>
                request.tools.some((tool) => tool.name === "attach_to_my_row"),
            ),
        ).toBe(false);
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
}, 60_000);
