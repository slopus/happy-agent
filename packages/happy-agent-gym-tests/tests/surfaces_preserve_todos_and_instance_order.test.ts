import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});
async function start() {
    const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
    running.push(gym);
    return gym;
}

describe("Surface instances through the real daemon", () => {
    it("normalizes a managed image, serves conditional bytes, and preserves it on restart", async () => {
        const gym = await start();
        const image = {
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        };
        const surface = (await gym.client.createSurface({ type: "todo", name: "Pictured", image }))
            .surface;
        expect(surface.image?.thumbhash.length).toBeGreaterThan(0);
        const bytes = (await gym.client.getSurfaceImage(surface.id))!;
        expect(bytes.contentType).toBe("image/webp");
        expect(bytes.etag).toMatch(/^"[a-f0-9]{64}"$/);
        expect(bytes.data.byteLength).toBeGreaterThan(0);
        expect(
            await gym.client.getSurfaceImage(surface.id, { ifNoneMatch: bytes.etag! }),
        ).toBeNull();
        await expect(
            gym.client.createSurface({
                type: "todo",
                name: "Invalid",
                image: { data: "bm90LWFuLWltYWdl" },
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect((await gym.client.listSurfaces()).surfaces).toEqual([surface]);
        await gym.restart();
        expect((await gym.client.getSurfaceImage(surface.id))!.etag).toBe(bytes.etag);
    });

    it.each(["read_only", "workspace_write", "auto-deny", "auto-allow"] as const)(
        "enforces %s on actual Surface administration",
        async (mode) => {
            const permissionMode = mode.startsWith("auto")
                ? ("auto" as const)
                : (mode as "read_only" | "workspace_write");
            let adminId = "";
            let called = false;
            const reviews: string[] = [];
            const gym = await createAgentGym({
                permissionMode,
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Surface</title>" }] };
                    if (request.sessionId !== adminId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    if (called) return { content: [{ type: "text", text: "Finished." }] };
                    called = true;
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "create_todo_tab",
                                arguments: { name: "Reviewed list", creatorUserId: null },
                            },
                        ],
                    };
                },
            });
            running.push(gym);
            adminId = (await gym.client.createBot({ name: "Administrator", isAdmin: true })).bot
                .agent.id;
            await gym.send("Create a shared todo Surface named Reviewed list.", {
                sessionId: adminId,
                permissionMode,
            });
            expect((await gym.client.listSurfaces()).surfaces).toHaveLength(
                mode === "auto-allow" ? 1 : 0,
            );
            expect(reviews).toHaveLength(mode.startsWith("auto") ? 1 : 0);
            if (reviews.length > 0)
                expect(reviews[0]).toContain("Create a shared todo Surface named Reviewed list.");
            expect(gym.errors).toEqual([]);
        },
    );

    it("creates independent named lists with nested members and durable personal order", async () => {
        const gym = await start();
        const client = gym.client;
        expect((await client.listSurfaces()).surfaces).toEqual([]);
        const a = (await client.createSurface({ type: "todo", name: "Shopping" })).surface;
        const b = (await client.createSurface({ type: "todo", name: "Work" })).surface;
        expect(a.id).not.toBe(b.id);
        expect(a.type).toBe("todo");
        expect(a.members).toEqual([{ userId: null, orderKey: "5", joinedAt: expect.any(Number) }]);
        expect(b.members[0]!.orderKey > a.members[0]!.orderKey).toBe(true);
        const moved = (await client.reorderSurface(b.id, { afterId: null, mutationId: "move" }))
            .surface;
        expect(moved.members[0]!.orderKey < a.members[0]!.orderKey).toBe(true);
        expect((await client.leaveSurface(a.id)).surface.members).toEqual([]);
        expect((await client.listSurfaces()).surfaces).toHaveLength(2);
        const rejoined = (await client.joinSurface(a.id)).surface;
        expect(rejoined.members[0]!.orderKey > moved.members[0]!.orderKey).toBe(true);
        expect((await client.getDesktopBootstrap()).surfaces).toEqual(
            (await client.listSurfaces()).surfaces,
        );
        await gym.waitUntil(
            async () =>
                (await client.getEvents({ limit: 1000 })).events.some(
                    (e) => e.type === "surface.updated" && e.payload.mutationId === "move",
                )
                    ? true
                    : undefined,
            "Surface events",
        );
        await gym.restart();
        expect((await gym.client.listSurfaces()).surfaces).toContainEqual(rejoined);
    });

    it("retains every todo revision through completion, deletion, reversion, and restart", async () => {
        const gym = await start();
        const client = gym.client;
        const surface = (await client.createSurface({ type: "todo", name: "Personal" })).surface;
        const first = (await client.createTodo(surface.id, { text: "Original" })).todo;
        const second = (await client.createTodo(surface.id, { text: "Second" })).todo;
        const edited = (
            await client.updateTodo(
                surface.id,
                first.id,
                { text: "Edited" },
                { ifMatch: first.version },
            )
        ).todo;
        const completed = (
            await client.updateTodo(
                surface.id,
                first.id,
                { status: "completed" },
                { ifMatch: edited.version },
            )
        ).todo;
        await expect(
            client.reorderTodo(
                surface.id,
                first.id,
                { afterId: null },
                { ifMatch: completed.version },
            ),
        ).rejects.toMatchObject({ status: 409 });
        const restored = (
            await client.updateTodo(
                surface.id,
                first.id,
                { status: "active" },
                { ifMatch: completed.version },
            )
        ).todo;
        expect(restored.orderKey! > second.orderKey!).toBe(true);
        const deleted = (
            await client.deleteTodo(surface.id, first.id, { ifMatch: restored.version })
        ).todo;
        expect(deleted.status).toBe("deleted");
        await expect(
            client.reorderTodo(
                surface.id,
                first.id,
                { afterId: null },
                { ifMatch: deleted.version },
            ),
        ).rejects.toMatchObject({ status: 409 });
        const third = (await client.createTodo(surface.id, { text: "Third" })).todo;
        const old = (await client.getTodoVersion(surface.id, first.id, first.version)).revision
            .todo;
        const reverted = (
            await client.updateTodo(
                surface.id,
                first.id,
                { text: old.text, status: old.status },
                { ifMatch: deleted.version },
            )
        ).todo;
        expect(reverted.text).toBe("Original");
        // Reactivation appends with a fresh key after every active todo rather than restoring the
        // revision's place, which the key one step past the last may happen to equal.
        expect(reverted.orderKey! > third.orderKey!).toBe(true);
        expect(reverted.orderKey! > second.orderKey!).toBe(true);
        const repositioned = (
            await client.reorderTodo(
                surface.id,
                first.id,
                { afterId: null },
                { ifMatch: reverted.version },
            )
        ).todo;
        expect((await client.listTodos(surface.id)).todos.map((todo) => todo.id)).toEqual([
            first.id,
            third.id,
            second.id,
        ]);
        expect(
            (
                await client.updateTodo(
                    surface.id,
                    first.id,
                    { text: old.text, status: old.status },
                    { ifMatch: repositioned.version },
                )
            ).todo,
        ).toEqual(repositioned);
        const history = await client.listTodoVersions(surface.id, first.id);
        expect(history.versions.map((r) => r.todo)).toEqual([
            first,
            edited,
            completed,
            restored,
            deleted,
            reverted,
            repositioned,
        ]);
        expect(history.versions.every((r) => r.source === "api" && r.actor.agentId === null)).toBe(
            true,
        );
        const page = await client.listTodoVersions(surface.id, first.id, { limit: 2 });
        expect(page.versions.map((r) => r.todo)).toEqual([first, edited]);
        expect(page.nextAfterVersion).toBe(edited.version);
        expect(
            (
                await client.listTodoVersions(surface.id, first.id, {
                    afterVersion: page.nextAfterVersion!,
                    limit: 2,
                })
            ).versions.map((r) => r.todo),
        ).toEqual([completed, restored]);
        await gym.restart();
        expect((await gym.client.listTodoVersions(surface.id, first.id)).versions).toEqual(
            history.versions,
        );
        expect(
            (await gym.client.getTodoVersion(surface.id, first.id, deleted.version)).revision.todo,
        ).toEqual(deleted);
    });

    it("isolates todo and history identities between lists and preserves rejected writes", async () => {
        const gym = await start();
        const client = gym.client;
        const a = (await client.createSurface({ type: "todo", name: "A" })).surface;
        const b = (await client.createSurface({ type: "todo", name: "B" })).surface;
        const todo = (await client.createTodo(a.id, { text: "Only A" })).todo;
        expect((await client.listTodos(b.id)).todos).toEqual([]);
        await expect(client.getTodo(b.id, todo.id)).rejects.toMatchObject({ status: 404 });
        await expect(client.getTodoVersion(b.id, todo.id, todo.version)).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            client.updateTodo(b.id, todo.id, { text: "Other list" }, { ifMatch: todo.version }),
        ).rejects.toMatchObject({ status: 404 });
        const changed = (
            await client.updateTodo(a.id, todo.id, { text: "New" }, { ifMatch: todo.version })
        ).todo;
        await expect(
            client.deleteTodo(a.id, todo.id, { ifMatch: todo.version }),
        ).rejects.toMatchObject({ status: 409 });
        expect((await client.listTodoVersions(a.id, todo.id)).versions.map((r) => r.todo)).toEqual([
            todo,
            changed,
        ]);
        const retried = await client.createTodo(a.id, {
            id: todo.id,
            text: "Retry must not replace",
        });
        expect(retried.todo).toEqual(changed);
    });

    it("serializes concurrent insertions and grants one winner for a shared version", async () => {
        const gym = await start();
        const client = gym.client;
        const surface = (await client.createSurface({ type: "todo", name: "Concurrent" })).surface;
        const created = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                client.createTodo(surface.id, { text: `Todo ${i}` }),
            ),
        );
        const list = (await client.listTodos(surface.id)).todos;
        expect(new Set(list.map((t) => t.orderKey)).size).toBe(8);
        const todo = created[0]!.todo;
        const outcomes = await Promise.allSettled([
            client.updateTodo(surface.id, todo.id, { text: "A" }, { ifMatch: todo.version }),
            client.updateTodo(surface.id, todo.id, { text: "B" }, { ifMatch: todo.version }),
        ]);
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
        expect((await client.listTodoVersions(surface.id, todo.id)).versions).toHaveLength(2);
    });

    it("runs actual Surface tools and rejects admin operations from an ordinary agent", async () => {
        let adminId = "";
        let nextAdminTool: { name: string; arguments: unknown } | undefined = {
            name: "create_todo_tab",
            arguments: { name: "Admin list", creatorUserId: null },
        };
        const calls = new Set<string>();
        const gym = await createAgentGym({
            permissionMode: "full_access",
            timeoutMs: 20000,
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Surface test</title>" }] };
                if (request.sessionId === adminId && nextAdminTool !== undefined) {
                    const tool = nextAdminTool;
                    nextAdminTool = undefined;
                    return { content: [{ type: "tool_call", ...tool }] };
                }
                if (request.sessionId === adminId)
                    return { content: [{ type: "text", text: "Finished." }] };
                if (calls.has(request.sessionId))
                    return { content: [{ type: "text", text: "Finished." }] };
                calls.add(request.sessionId);
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_todo_tab",
                            arguments: {
                                name: request.sessionId === adminId ? "Admin list" : "Denied",
                                creatorUserId: null,
                            },
                        },
                    ],
                };
            },
        });
        running.push(gym);
        await gym.send("Create a Surface.", { permissionMode: "full_access" });
        expect((await gym.client.listSurfaces()).surfaces).toEqual([]);
        const admin = (await gym.client.createBot({ name: "Admin", isAdmin: true })).bot;
        adminId = admin.agent.id;
        const sendOptions = { sessionId: admin.agent.id, permissionMode: "full_access" as const };
        await gym.send("Create a todo Surface named Admin list.", sendOptions);
        const surfaces = (await gym.client.listSurfaces()).surfaces;
        expect(
            surfaces.map((s) => s.name),
            JSON.stringify(gym.inference.toolResults()),
        ).toEqual(["Admin list"]);
        const surfaceId = surfaces[0]!.id;
        nextAdminTool = { name: "remove_tab_user", arguments: { tabId: surfaceId, userId: null } };
        await gym.send("Remove me from the Surface sidebar.", sendOptions);
        expect((await gym.client.listSurfaces()).surfaces[0]!.members).toEqual([]);
        nextAdminTool = {
            name: "create_todo",
            arguments: { tabId: surfaceId, text: "From a tool", authorUserId: null },
        };
        await gym.send("Create a todo on that Surface without joining.", sendOptions);
        const todo = (await gym.client.listTodos(surfaceId)).todos[0]!;
        expect(todo.text).toBe("From a tool");
        nextAdminTool = {
            name: "update_todo",
            arguments: {
                tabId: surfaceId,
                todoId: todo.id,
                version: todo.version,
                status: "completed",
            },
        };
        await gym.send("Complete the todo.", sendOptions);
        const history = await gym.client.listTodoVersions(surfaceId, todo.id);
        expect(history.versions.map((revision) => revision.todo.status)).toEqual([
            "active",
            "completed",
        ]);
        expect(
            history.versions.every(
                (revision) =>
                    revision.source === "tool" &&
                    revision.actor.agentId === adminId &&
                    revision.actor.userId === null,
            ),
        ).toBe(true);
        expect((await gym.client.listSurfaces()).surfaces[0]!.members).toEqual([]);
        nextAdminTool = { name: "add_tab_user", arguments: { tabId: surfaceId, userId: null } };
        await gym.send("Add me to the Surface again.", sendOptions);
        expect((await gym.client.listSurfaces()).surfaces[0]!.members).toHaveLength(1);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
