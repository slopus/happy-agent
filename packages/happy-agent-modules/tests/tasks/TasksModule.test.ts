import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { TasksModule } from "../../sources/tasks/TasksModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

describe("TasksModule durable tools", () => {
    it("uses the tool-call ID and marks each mutation transactional", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-tool-commit-test");
        await database.ready;

        try {
            const call = (id: string) =>
                ({
                    id,
                    kv: {},
                }) as never;
            const scope = { agent: { id: "agent-a" } } as AgentModuleScope;
            const hooks = await resolveModuleHooks(database.context, tasks);
            const [create, , , update, complete] = await hooks.tools!(database.context, scope);
            expect([create?.transactional, update?.transactional, complete?.transactional]).toEqual(
                [true, true, true],
            );

            const created = await create!.execute(
                database.context,
                { title: "Ship the task cleanup" },
                call("call-task-1"),
            );
            expect(created.task.id).toBe("call-task-1");

            const updated = await update!.execute(
                database.context,
                { id: created.task.id, priority: "high" },
                call("call-update-1"),
            );
            expect(updated.task.priority).toBe("high");

            const completed = await complete!.execute(
                database.context,
                { id: created.task.id },
                call("call-complete-1"),
            );
            expect(completed.task.status).toBe("completed");

            await expect(
                create!.execute(
                    database.context,
                    { title: "Ship the task cleanup" },
                    call("call-task-1"),
                ),
            ).resolves.toMatchObject({
                success: false,
                taskId: "call-task-1",
                error: 'Task "call-task-1" already exists.',
            });
        } finally {
            database.close();
        }
    });

    it("treats an existing public task ID as a conflict even for identical input", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-existing-id-test");
        await database.ready;

        try {
            const input = { id: "existing", title: "Existing task" } as const;
            await tasks.create(database.context, "agent-a", input);
            await expect(tasks.create(database.context, "agent-a", input)).rejects.toThrow(
                'Task "existing" already exists.',
            );
        } finally {
            database.close();
        }
    });

    it("keeps task metadata, assignments, and both dependency directions in sync", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-parity-fields-test");
        await database.ready;

        try {
            await tasks.create(database.context, "agent-a", {
                id: "blocking",
                title: "Blocking task",
            });
            await tasks.create(database.context, "agent-a", {
                id: "blocked",
                title: "Blocked task",
                activeForm: "Building the feature",
                metadata: { source: "legacy", nested: { count: 1 } },
                owner: "worker-1",
            });

            const updated = await tasks.update(database.context, "agent-a", "blocked", {
                addBlockedBy: ["blocking"],
            });
            expect(updated.dependsOn).toEqual(["blocking"]);
            expect(updated.activeForm).toBe("Building the feature");
            expect(updated.owner).toBe("worker-1");
            expect(updated.metadata).toEqual({ source: "legacy", nested: { count: 1 } });
            expect((await tasks.get(database.context, "agent-a", "blocking"))?.blocks).toEqual([
                "blocked",
            ]);

            await tasks.update(database.context, "agent-a", "blocking", {
                removeBlocks: ["blocked"],
            });
            expect((await tasks.get(database.context, "agent-a", "blocking"))?.blocks).toEqual([]);

            await tasks.update(database.context, "agent-a", "blocking", {
                addBlocks: ["blocked"],
            });
            expect((await tasks.get(database.context, "agent-a", "blocked"))?.dependsOn).toEqual([
                "blocking",
            ]);

            await tasks.update(database.context, "agent-a", "blocked", {
                metadata: { source: null, added: true },
                removeBlockedBy: ["blocking"],
                activeForm: null,
                owner: null,
            });
            expect(await tasks.get(database.context, "agent-a", "blocked")).toMatchObject({
                dependsOn: [],
                metadata: { nested: { count: 1 }, added: true },
            });
            expect((await tasks.get(database.context, "agent-a", "blocking"))?.blocks).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("returns normal tool results for validation failures, filters completed blockers, and removes tasks", async () => {
        const tasks = new TasksModule();
        const database = moduleDatabase(tasks.migrations, "tasks-tool-parity-test");
        await database.ready;

        try {
            const call = (id: string) =>
                ({
                    id,
                    kv: {},
                }) as never;
            const scope = { agent: { id: "agent-a" } } as AgentModuleScope;
            const hooks = await resolveModuleHooks(database.context, tasks);
            const [create, , get, update, complete, remove] = await hooks.tools!(
                database.context,
                scope,
            );
            const blocking = await create!.execute(
                database.context,
                { title: "Blocking task" },
                call("blocking"),
            );
            await create!.execute(
                database.context,
                { title: "Blocked task", dependsOn: [blocking.task.id] },
                call("blocked"),
            );

            await complete!.execute(
                database.context,
                { id: blocking.task.id },
                call("complete-blocking"),
            );
            const page = await tasks.listPage(database.context, "agent-a");
            expect(page.tasks.find((task) => task.id === "blocked")?.dependsOn).toEqual([]);
            const detail = await get!.execute(
                database.context,
                { id: "blocked" },
                call("get-blocked"),
            );
            expect(detail).toMatchObject({ dependencies: ["blocking"] });

            const unknownUpdate = await update!.execute(
                database.context,
                { id: "missing", title: "No task" },
                call("update-missing"),
            );
            expect(unknownUpdate).toMatchObject({
                success: false,
                taskId: "missing",
            });

            const selfDependency = await create!.execute(
                database.context,
                { title: "Invalid", dependsOn: ["self"] },
                call("self"),
            );
            expect(selfDependency).toMatchObject({
                success: false,
                taskId: "self",
            });

            const removed = await remove!.execute(
                database.context,
                { id: "blocking" },
                call("remove-blocking"),
            );
            expect(removed).toEqual({ removed: true, taskId: "blocking" });
            expect(await tasks.get(database.context, "agent-a", "blocking")).toBeUndefined();
            expect((await tasks.get(database.context, "agent-a", "blocked"))?.dependsOn).toEqual(
                [],
            );
            const deleted = await update!.execute(
                database.context,
                { id: "blocked", status: "deleted" },
                call("delete-blocked"),
            );
            expect(deleted).toEqual({ removed: true, taskId: "blocked" });
            expect(await tasks.get(database.context, "agent-a", "blocked")).toBeUndefined();
        } finally {
            database.close();
        }
    });
});
