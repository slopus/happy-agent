import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentBaseAcceptedMessage,
    type AgentConfig,
    type AgentKV,
    type AgentModuleScope,
    type AgentQueuedMessage,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { botMigrations, BotsModule } from "../../sources/bots/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import {
    STANDALONE_TASK_MEMBER,
    taskMigrations,
    TaskConflictError,
    TaskInputError,
    TaskNotFoundError,
    taskRecordSchema,
    TASK_MEMBERS_TABLE,
    TASKS_TABLE,
    TasksModule,
    type TaskEvent,
    type TaskRecord,
} from "../../sources/tasks/index.js";
import { TitlesModule } from "../../sources/titles/index.js";
import { WorkspacesModule, workspaceMigrations } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { sharedKV } from "../support/fixtures.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsCatalogFor } from "../support/projectsModule.js";

const OWNER = "ownerusera1b2c3d4e5f6g7h8";
const OTHER_OWNER = "ownerusero9p8q7r6s5t4u3v2";

class TaskAgents {
    readonly configs = new Map<string, AgentConfig>();
    readonly parents = new Map<string, string | null>();
    readonly aborted: string[] = [];
    readonly sent: {
        readonly agentId: string;
        readonly message: AgentQueuedMessage;
        readonly id: string | undefined;
    }[] = [];

    async create(
        _ctx: Context,
        config: AgentConfig,
        options: { readonly id?: string; readonly parent?: string | null } = {},
    ) {
        const id = options.id ?? "generatedagent";
        if (this.configs.has(id)) throw new Error("Agent already exists.");
        this.configs.set(id, structuredClone(config));
        this.parents.set(id, options.parent ?? null);
        return { id };
    }

    async config(_ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return structuredClone(this.configs.get(agentId));
    }

    async updateMetadata(
        _ctx: Context,
        agentId: string,
        update: NonNullable<AgentConfig["metadata"]>,
    ): Promise<void> {
        const config = this.configs.get(agentId);
        if (config === undefined) throw new Error("Agent missing.");
        this.configs.set(agentId, {
            ...config,
            metadata: { ...config.metadata, ...structuredClone(update) },
        });
    }

    async send(
        _ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options: { readonly id?: string } = {},
    ) {
        if (!this.configs.has(agentId)) throw new Error("Agent missing.");
        this.sent.push({ agentId, message: structuredClone(message), id: options.id });
        return { id: options.id ?? "generatedmessage" };
    }

    async childOf(_ctx: Context, agentId: string): Promise<readonly string[]> {
        return [...this.parents].flatMap(([child, parent]) => (parent === agentId ? [child] : []));
    }

    async parentOf(_ctx: Context, agentId: string): Promise<string | null> {
        return this.parents.get(agentId) ?? null;
    }

    async abort(ctx: Context, agentId: string): Promise<void> {
        afterCommit(ctx, () => {
            this.aborted.push(agentId);
        });
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

describe("TasksModule", () => {
    it("lets a bot create a task owned by its current team sender, in a dedicated folder", async () => {
        const fixture = await started("tasks-bot-creates");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            await fixture.accept(bot.agentId, { role: "user", userId: OWNER });
            await fixture.accept(bot.agentId, { role: "agent" });

            const task = await fixture.executeCreate(bot.agentId, {
                name: "Fix login redirect",
                text: "Find why the login redirect loops and fix it.",
            });

            expect(task).toMatchObject({
                name: "Fix login redirect",
                folderName: "fix_login_redirect",
                ownerUserId: OWNER,
                creatorAgentId: bot.agentId,
                status: "active",
                version: 1,
            });
            // A task has no avatar: its stored shape cannot carry one.
            expect(Object.keys(task)).not.toContain("avatar");
            expect(Object.keys(task)).not.toContain("isAdmin");
            expect(
                Value.Check(taskRecordSchema, {
                    ...task,
                    avatar: {
                        kind: "image",
                        source: "user",
                        thumbhash: "3OcRJYB4d3h3iIeHeEh3eIhw",
                    },
                }),
            ).toBe(false);

            expect(task.path).toBe(join(fixture.config.tasksHome, "fix_login_redirect"));
            expect((await stat(task.path)).isDirectory()).toBe(true);
            expect(new Set([task.id, task.workspaceId, task.agentId]).size).toBe(3);

            const agent = fixture.agents.configs.get(task.agentId);
            expect(fixture.agents.parents.get(task.agentId)).toBeNull();
            expect(agent?.metadata?.title).toBe("Fix login redirect");
            expect(agent?.environment?.workingDirectory).toBe(task.path);
            expect(agent?.modules?.["compute"]).toMatchObject({
                cwd: task.path,
                secretScope: { workspaceId: task.workspaceId },
            });

            expect(fixture.agents.sent).toEqual([
                {
                    agentId: task.agentId,
                    id: task.agentId,
                    message: {
                        role: "agent",
                        author: { id: bot.agentId, description: `Agent ${bot.agentId}` },
                        content: [
                            {
                                type: "text",
                                text: `Message from agent ${bot.agentId}:\n\nFind why the login redirect loops and fix it.`,
                            },
                        ],
                    },
                },
            ]);
            expect(fixture.events.map((event) => event.type)).toEqual([
                "task_created",
                "task_joined",
            ]);
            await expect(
                fixture.tasks.forAgent(fixture.database.context, task.agentId),
            ).resolves.toEqual(task);
            await expect(
                fixture.tasks.forWorkspace(fixture.database.context, task.workspaceId),
            ).resolves.toEqual(task);
        } finally {
            await fixture.close();
        }
    });

    it("follows the human sender, never an agent, and records no owner when standalone", async () => {
        const fixture = await started("tasks-owner");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            await fixture.accept(bot.agentId, { role: "user" });
            const standalone = await fixture.executeCreate(bot.agentId, { name: "Standalone" });
            expect(standalone.ownerUserId).toBeUndefined();

            await fixture.accept(bot.agentId, { role: "user", userId: OWNER });
            await fixture.accept(bot.agentId, { role: "user", userId: OTHER_OWNER });
            await fixture.accept(bot.agentId, { role: "agent", userId: OWNER });
            await fixture.accept(bot.agentId, { role: "user", userId: OWNER, synthetic: true });
            const owned = await fixture.executeCreate(bot.agentId, { name: "Owned" });
            expect(owned.ownerUserId).toBe(OTHER_OWNER);

            // An unidentified human takes ownership away from the previous sender.
            await fixture.accept(bot.agentId, { role: "user" });
            const unowned = await fixture.executeCreate(bot.agentId, { name: "Unowned" });
            expect(unowned.ownerUserId).toBeUndefined();

            await expect(fixture.instructions(owned.agentId)).resolves.toBe(
                [
                    "# Task identity",
                    "",
                    'You are the persistent task named "Owned": one continuous conversation with a dedicated folder of its own. Use this task name when referring to the work. Happy Agent is the runtime that powers you, not your task name.',
                    `- Task ID: \`${owned.id}\``,
                    `- Folder: \`${owned.path}\``,
                    `- Owner: user ID \`${OTHER_OWNER}\``,
                    `- Created by agent \`${bot.agentId}\``,
                    "",
                    "Keep this task's own notes and files in its folder. Strongly prefer doing repository work in workspace-bound subtasks: use create_subtask with the relevant project so the work gets its own project workspace, instead of changing directories into a repository from this folder.",
                    "",
                    `This task was created by the bot named "Planner" (bot ID \`${bot.id}\`). Its messages arrive as agent messages. Report progress, results, and blockers to it with send_bot_message.`,
                ].join("\n"),
            );
            await expect(fixture.instructions("someoneelsesagent")).resolves.toBe("");
        } finally {
            await fixture.close();
        }
    });

    it("finds the task it already created when a durable call repeats", async () => {
        const fixture = await started("tasks-durable-retry");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            const remembered = new Map<string, unknown>();
            const first = await fixture.executeCreate(
                bot.agentId,
                { name: "Release notes", text: "Draft them." },
                remembered,
            );
            const repeated = await fixture.executeCreate(
                bot.agentId,
                { name: "Release notes", text: "Draft them." },
                remembered,
            );
            expect(repeated).toEqual(first);
            expect(await fixture.tasks.list(fixture.database.context)).toHaveLength(1);
            expect(fixture.agents.sent).toHaveLength(1);
            expect(fixture.events.map((event) => event.type)).toEqual([
                "task_created",
                "task_joined",
            ]);

            const second = await fixture.executeCreate(bot.agentId, { name: "Release notes" });
            expect(second.folderName).toBe("release_notes_2");
            expect(
                (await fixture.tasks.list(fixture.database.context)).map((task) => task.id),
            ).toEqual([first.id, second.id]);
        } finally {
            await fixture.close();
        }
    });

    it("refuses an opening message without its sender and conflicting identities", async () => {
        const fixture = await started("tasks-input");
        try {
            await expect(
                fixture.tasks.create(fixture.database.context, { name: "Orphan", text: "Hi" }),
            ).rejects.toBeInstanceOf(TaskInputError);
            const created = await fixture.tasks.create(fixture.database.context, {
                id: "taskidentity1",
                name: "Direct",
            });
            expect(created.creatorAgentId).toBeUndefined();
            expect(fixture.agents.sent).toEqual([]);
            await expect(
                fixture.tasks.create(fixture.database.context, {
                    id: "taskidentity1",
                    agentId: "anotheragent1",
                    name: "Direct",
                }),
            ).rejects.toBeInstanceOf(TaskConflictError);
            await expect(
                fixture.tasks.create(fixture.database.context, {
                    id: "taskidentity2",
                    agentId: created.agentId,
                    name: "Clash",
                }),
            ).rejects.toBeInstanceOf(TaskConflictError);
            // Bots reserve their identities against the task catalog too.
            await expect(
                fixture.bots.create(fixture.database.context, {
                    id: created.workspaceId,
                    name: "Clash",
                }),
            ).rejects.toThrow("A requested identity is already in use.");
        } finally {
            await fixture.close();
        }
    });

    it("offers the task catalog to bots and people, but not to tasks or subagents", async () => {
        const fixture = await started("tasks-tools");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            const task = await fixture.executeCreate(bot.agentId, { name: "Research" });
            fixture.agents.parents.set("helperagent1", bot.agentId);
            fixture.agents.parents.set("humanroot1", null);

            const catalog = ["create_task", "list_tasks", "send_task_message", "archive_task"];
            expect(await fixture.taskTools(bot.agentId)).toEqual(catalog);
            expect(await fixture.taskTools("humanroot1")).toEqual(catalog);
            expect(await fixture.taskTools(task.agentId)).toEqual([]);
            expect(await fixture.taskTools("helperagent1")).toEqual([]);

            // A task reaches bots, but cannot create one or set an avatar.
            expect(await fixture.botTools(task.agentId)).toEqual(["list_bots", "send_bot_message"]);
            expect(await fixture.botTools(bot.agentId)).toContain("create_bot");
        } finally {
            await fixture.close();
        }
    });

    it("lists tasks with owners in bounded pages", async () => {
        const fixture = await started("tasks-list");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            await fixture.accept(bot.agentId, { role: "user", userId: OWNER });
            const first = await fixture.executeCreate(bot.agentId, { name: "First" });
            const second = await fixture.executeCreate(bot.agentId, { name: "Second" });
            await fixture.tasks.archive(fixture.database.context, second.id, second.version);

            const list = await fixture.tool(bot.agentId, "list_tasks");
            const page = (await list.execute(
                fixture.database.context,
                { limit: 1 },
                {} as never,
            )) as {
                tasks: { task: TaskRecord; owner: string | null }[];
                total: number;
                nextOffset?: number;
            };
            expect(page).toMatchObject({ total: 2, nextOffset: 1 });
            expect(page.tasks.map(({ task }) => task.id)).toEqual([first.id]);
            expect(page.tasks[0]?.owner).toBe(`user ID \`${OWNER}\``);
            const text = JSON.stringify(list.toLLM(page as never));
            expect(text).toContain(`First — id ${first.id}, owner user ID`);
            expect(text).toContain("continue with offset 1");

            const archived = (await list.execute(
                fixture.database.context,
                { status: "archived" },
                {} as never,
            )) as { tasks: { task: TaskRecord }[]; total: number };
            expect(archived.tasks.map(({ task }) => task.id)).toEqual([second.id]);
        } finally {
            await fixture.close();
        }
    });

    it("messages active tasks and refuses archived ones and self-messages", async () => {
        const fixture = await started("tasks-messages");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            const task = await fixture.executeCreate(bot.agentId, { name: "Research" });
            await fixture.tasks.sendMessage(
                fixture.database.context,
                bot.agentId,
                task.id,
                "Any progress?",
                "followupmessage1",
            );
            expect(fixture.agents.sent.at(-1)).toMatchObject({
                agentId: task.agentId,
                id: "followupmessage1",
            });
            await expect(
                fixture.tasks.sendMessage(
                    fixture.database.context,
                    task.agentId,
                    task.id,
                    "Me?",
                    "selfmessage1",
                ),
            ).rejects.toBeInstanceOf(TaskConflictError);
            await fixture.tasks.archive(fixture.database.context, task.id, task.version);
            await expect(
                fixture.tasks.sendMessage(
                    fixture.database.context,
                    bot.agentId,
                    task.id,
                    "Still there?",
                    "latemessage1",
                ),
            ).rejects.toThrow("archived");
        } finally {
            await fixture.close();
        }
    });

    it("archives like a bot: stops work, archives the agent, records cleanup, and restores", async () => {
        const fixture = await started("tasks-archive");
        try {
            const bot = await fixture.bots.create(fixture.database.context, { name: "Planner" });
            const task = await fixture.executeCreate(bot.agentId, { name: "Research" });
            const otherBot = await fixture.bots.create(fixture.database.context, { name: "Other" });
            const archiveTool = async (agentId: string) =>
                await (
                    await fixture.tool(agentId, "archive_task")
                ).execute(fixture.database.context, { taskId: task.id }, {} as never);

            await expect(archiveTool(otherBot.agentId)).rejects.toThrow(
                "Only the agent that created a task may archive it.",
            );
            const archived = (await archiveTool(bot.agentId)) as TaskRecord;
            expect(archived).toMatchObject({
                status: "archived",
                archivedAt: expect.any(Number),
                version: 2,
                workspaceVersion: task.workspaceVersion + 1,
            });
            expect(fixture.agents.aborted).toEqual([task.agentId]);
            expect(fixture.agents.configs.get(task.agentId)?.metadata?.["archivedAt"]).toEqual(
                expect.any(Number),
            );
            expect(fixture.durable.invoke).toHaveBeenCalledWith(expect.anything(), {
                function: "tasks.archive",
                arguments: { agentId: task.agentId },
                operationId: `task-archive:${task.agentId}`,
                lockKeys: [`task:${task.agentId}`],
            });
            // The folder is kept; archival is logical.
            expect((await stat(task.path)).isDirectory()).toBe(true);
            await expect(archiveTool(bot.agentId)).resolves.toEqual(archived);

            const restored = await fixture.tasks.unarchive(
                fixture.database.context,
                task.id,
                archived.version,
            );
            expect(restored.status).toBe("active");
            expect(restored.archivedAt).toBeUndefined();
            expect(fixture.agents.configs.get(task.agentId)?.metadata?.["archivedAt"]).toBeNull();
            expect(fixture.durable.cancel).toHaveBeenCalledWith(
                expect.anything(),
                `task-archive:${task.agentId}`,
            );
        } finally {
            await fixture.close();
        }
    });

    it("renames the task and its conversation with version checks", async () => {
        const fixture = await started("tasks-rename");
        try {
            const first = await fixture.tasks.create(fixture.database.context, { name: "First" });
            const renamed = await fixture.tasks.rename(
                fixture.database.context,
                first.id,
                "Renamed",
                first.version,
            );
            expect(renamed).toMatchObject({ name: "Renamed", folderName: "first", version: 2 });
            expect(fixture.agents.configs.get(first.agentId)?.metadata?.title).toBe("Renamed");
            await expect(
                fixture.tasks.rename(fixture.database.context, first.id, "Stale", first.version),
            ).rejects.toBeInstanceOf(TaskConflictError);
        } finally {
            await fixture.close();
        }
    });

    it("joins the owner at the top of their own list and keeps the global list in creation order", async () => {
        const fixture = await started("tasks-owner-joins", { team: true });
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Planner" });
            await fixture.accept(bot.agentId, { role: "user", userId: OWNER });
            const first = await fixture.executeCreate(bot.agentId, { name: "First" });
            const second = await fixture.executeCreate(bot.agentId, { name: "Second" });
            await fixture.accept(bot.agentId, { role: "user", userId: OTHER_OWNER });
            const theirs = await fixture.executeCreate(bot.agentId, { name: "Theirs" });
            // Only a human sender owns a task; nobody joins one created on an agent's behalf.
            await fixture.accept(bot.agentId, { role: "user" });
            const unowned = await fixture.executeCreate(bot.agentId, { name: "Unowned" });

            const ids = (listed: readonly { readonly task: TaskRecord }[]) =>
                listed.map(({ task }) => task.id);
            expect((await fixture.tasks.list(ctx)).map((task) => task.id)).toEqual([
                first.id,
                second.id,
                theirs.id,
                unowned.id,
            ]);
            expect(ids(await fixture.tasks.listForMember(ctx, OWNER))).toEqual([
                second.id,
                first.id,
            ]);
            expect(ids(await fixture.tasks.listForMember(ctx, OTHER_OWNER))).toEqual([theirs.id]);
            expect(await fixture.tasks.listForMember(ctx, STANDALONE_TASK_MEMBER)).toEqual([]);
            expect(fixture.events.filter((event) => event.type === "task_joined")).toHaveLength(3);
        } finally {
            await fixture.close();
        }
    });

    it("lets anyone join and leave a task, idempotently and only in their own list", async () => {
        const fixture = await started("tasks-join-leave", { team: true });
        try {
            const ctx = fixture.database.context;
            const task = await fixture.tasks.create(ctx, { name: "Shared", ownerUserId: OWNER });
            fixture.events.length = 0;

            const joined = await fixture.tasks.join(ctx, task.id, OTHER_OWNER);
            expect(joined).toMatchObject({
                joined: true,
                membership: { taskId: task.id, memberId: OTHER_OWNER },
            });
            const again = await fixture.tasks.join(ctx, task.id, OTHER_OWNER);
            expect(again).toEqual({ membership: joined.membership, joined: false });
            await expect(fixture.tasks.membership(ctx, task.id, OTHER_OWNER)).resolves.toEqual(
                joined.membership,
            );

            await expect(fixture.tasks.leave(ctx, task.id, OTHER_OWNER)).resolves.toEqual(
                joined.membership,
            );
            await expect(fixture.tasks.leave(ctx, task.id, OTHER_OWNER)).resolves.toBeUndefined();
            await expect(fixture.tasks.membership(ctx, task.id, OTHER_OWNER)).resolves.toBe(
                undefined,
            );
            // Leaving is the member's choice alone, the owner's included, and touches no one else.
            expect(
                (await fixture.tasks.listForMember(ctx, OWNER)).map(({ task: t }) => t.id),
            ).toEqual([task.id]);
            await fixture.tasks.leave(ctx, task.id, OWNER);
            expect(await fixture.tasks.listForMember(ctx, OWNER)).toEqual([]);
            expect((await fixture.tasks.get(ctx, task.id))?.ownerUserId).toBe(OWNER);

            // Archived tasks can still be joined; unknown tasks and members are refused.
            await fixture.tasks.archive(ctx, task.id, task.version);
            await expect(fixture.tasks.join(ctx, task.id, OWNER)).resolves.toMatchObject({
                joined: true,
            });
            await expect(fixture.tasks.join(ctx, "missingtask1", OWNER)).rejects.toBeInstanceOf(
                TaskNotFoundError,
            );
            await expect(fixture.tasks.join(ctx, task.id, "Not A User")).rejects.toBeInstanceOf(
                TaskInputError,
            );
            expect(
                fixture.events
                    .filter((event) => event.type !== "task_updated")
                    .map((event) => event.type),
            ).toEqual(["task_joined", "task_left", "task_left", "task_joined"]);
        } finally {
            await fixture.close();
        }
    });

    it("reorders one member's list without moving anyone else's", async () => {
        const fixture = await started("tasks-member-order", { team: true });
        try {
            const ctx = fixture.database.context;
            const a = await fixture.tasks.create(ctx, { name: "Alpha", ownerUserId: OWNER });
            const b = await fixture.tasks.create(ctx, { name: "Bravo", ownerUserId: OWNER });
            const c = await fixture.tasks.create(ctx, { name: "Charlie", ownerUserId: OWNER });
            for (const task of [a, b, c]) await fixture.tasks.join(ctx, task.id, OTHER_OWNER);
            const order = async (member: string) =>
                (await fixture.tasks.listForMember(ctx, member)).map(({ task }) => task.name);
            expect(await order(OWNER)).toEqual(["Charlie", "Bravo", "Alpha"]);
            expect(await order(OTHER_OWNER)).toEqual(["Charlie", "Bravo", "Alpha"]);
            const before = await fixture.tasks.membership(ctx, a.id, OTHER_OWNER);
            fixture.events.length = 0;

            const moved = await fixture.tasks.reorder(ctx, a.id, OWNER, null);
            expect(await order(OWNER)).toEqual(["Alpha", "Charlie", "Bravo"]);
            await fixture.tasks.reorder(ctx, c.id, OWNER, b.id);
            expect(await order(OWNER)).toEqual(["Alpha", "Bravo", "Charlie"]);
            expect(await order(OTHER_OWNER)).toEqual(["Charlie", "Bravo", "Alpha"]);
            await expect(fixture.tasks.membership(ctx, a.id, OTHER_OWNER)).resolves.toEqual(before);
            // The task itself does not change: order belongs to the membership.
            expect((await fixture.tasks.get(ctx, a.id))?.version).toBe(a.version);
            expect(fixture.events.map((event) => event.type)).toEqual([
                "task_reordered",
                "task_reordered",
            ]);
            expect(fixture.events[0]).toMatchObject({ membership: moved });

            // Moving to where it already is changes nothing.
            await expect(fixture.tasks.reorder(ctx, a.id, OWNER, null)).resolves.toEqual(moved);
            expect(fixture.events).toHaveLength(2);

            await expect(fixture.tasks.reorder(ctx, a.id, OWNER, a.id)).rejects.toThrow(
                "A task cannot be placed after itself.",
            );
            const lone = await fixture.tasks.create(ctx, {
                name: "Lone",
                ownerUserId: OTHER_OWNER,
            });
            await expect(fixture.tasks.reorder(ctx, lone.id, OWNER, null)).rejects.toThrow(
                "Join the task before moving it in your list.",
            );
            await expect(fixture.tasks.reorder(ctx, a.id, OWNER, lone.id)).rejects.toThrow(
                "The task to place after is not in your list.",
            );
        } finally {
            await fixture.close();
        }
    });

    it("gives a standalone installation's one person every task it creates", async () => {
        const fixture = await started("tasks-standalone-member");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Planner" });
            await fixture.accept(bot.agentId, { role: "user" });
            const task = await fixture.executeCreate(bot.agentId, { name: "Mine" });
            expect(task.ownerUserId).toBeUndefined();
            expect(fixture.tasks.memberFor(undefined)).toBe(STANDALONE_TASK_MEMBER);
            expect(
                (await fixture.tasks.listForMember(ctx, STANDALONE_TASK_MEMBER)).map(
                    ({ membership }) => membership,
                ),
            ).toEqual([expect.objectContaining({ taskId: task.id, memberId: "standalone" })]);
        } finally {
            await fixture.close();
        }
    });

    it("lists the joined tasks of the person a conversation works for, in their order", async () => {
        const fixture = await started("tasks-list-joined", { team: true });
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Planner" });
            const list = await fixture.tool(bot.agentId, "list_tasks");
            const joined = async () =>
                (
                    (await list.execute(ctx, { scope: "joined" }, {} as never)) as {
                        tasks: { task: TaskRecord }[];
                    }
                ).tasks.map(({ task }) => task.name);

            await expect(joined()).rejects.toThrow("No person is identified in this conversation");
            await fixture.accept(bot.agentId, { role: "user", userId: OWNER });
            const first = await fixture.executeCreate(bot.agentId, { name: "First" });
            await fixture.executeCreate(bot.agentId, { name: "Second" });
            await fixture.tasks.create(ctx, { name: "Elsewhere", ownerUserId: OTHER_OWNER });
            expect(await joined()).toEqual(["Second", "First"]);
            await fixture.tasks.reorder(ctx, first.id, OWNER, null);
            expect(await joined()).toEqual(["First", "Second"]);

            const all = (await list.execute(ctx, { scope: "all" }, {} as never)) as {
                tasks: { task: TaskRecord }[];
            };
            expect(all.tasks.map(({ task }) => task.name)).toEqual([
                "First",
                "Second",
                "Elsewhere",
            ]);
        } finally {
            await fixture.close();
        }
    });

    it("drops the retired checklist table before creating the task catalog", async () => {
        const database = moduleDatabase(taskMigrations.slice(0, 1), "tasks-legacy-migration");
        try {
            await database.ready;
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_task_state (agent_id, tasks_json)
                    VALUES ('legacyagent', '[]')`,
            );
            for (const [, migrate] of taskMigrations.slice(1)) {
                await migrate(database.context, database.database);
            }
            const tables = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
            );
            expect(tables.map((table) => table.name)).toContain(TASKS_TABLE);
            expect(tables.map((table) => table.name)).toContain(TASK_MEMBERS_TABLE);
            expect(tables.map((table) => table.name)).not.toContain("happy_agent_task_state");
            expect(taskMigrations.map(([key]) => key)).toEqual([
                "001-task-state",
                "002-task-list-removed",
                "003-task-catalog",
            ]);
        } finally {
            database.close();
        }
    });
});

interface AcceptedSender {
    readonly role: "user" | "agent";
    readonly userId?: string;
    /** A user-role message the system produced, which never names a human sender. */
    readonly synthetic?: boolean;
}

async function started(name: string, options: { readonly team?: boolean } = {}) {
    const config = await temporaryTestConfig(
        [
            "[features]",
            "workspaces = false",
            ...(options.team === true
                ? [
                      "[feature.team]",
                      "enabled = true",
                      'workos_organization_id = "org_test"',
                      'owner_workos_user_id = "user_test"',
                  ]
                : []),
            "",
        ].join("\n"),
    );
    const database = moduleDatabase(
        [...projectMigrations, ...workspaceMigrations, ...botMigrations, ...taskMigrations],
        name,
    );
    await database.ready;
    const compute = new ComputeModule(config, new SecretsModule());
    const abort = new AbortModule(compute);
    const agents = new TaskAgents();
    abort.beforeStart(database.context, agents.asRef());
    const git = new GitModule();
    const { projects, runners } = projectsCatalogFor(config, git);
    const workspaces = new WorkspacesModule(
        config,
        projects,
        git,
        abort,
        new DurableFunctionsModule(),
        runners,
    );
    const durable = { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() };
    const tasks = new TasksModule(
        config,
        abort,
        projects,
        workspaces,
        runners,
        compute,
        durable as unknown as DurableFunctionsModule,
    );
    const taskHooks = tasks.beforeStart(database.context, agents.asRef());
    const titles = new TitlesModule(config, new HistoryModule(), workspaces);
    const bots = new BotsModule(config, abort, titles, projects, workspaces, runners, tasks);
    const botHooks = bots.beforeStart(database.context, agents.asRef());
    const events: TaskEvent[] = [];
    tasks.onEvent((_ctx, event) => {
        events.push(event);
    });
    const kvs = new Map<string, AgentKV>();
    const scopeFor = (agentId: string): AgentModuleScope => {
        const kv = kvs.get(agentId) ?? sharedKV();
        kvs.set(agentId, kv);
        return { agent: { id: agentId, provider: "scripted" }, kv } as AgentModuleScope;
    };
    const taskToolsFor = async (agentId: string): Promise<readonly AnyAgentTool[]> =>
        (await taskHooks.tools?.(database.context, scopeFor(agentId))) ?? [];
    const tool = async (agentId: string, toolName: string): Promise<AnyAgentTool> => {
        const found = (await taskToolsFor(agentId)).find(
            (candidate) => candidate.name === toolName,
        );
        if (found === undefined) throw new Error(`The ${toolName} tool is missing.`);
        return found;
    };
    return {
        agents,
        bots,
        config,
        database,
        durable,
        events,
        tasks,
        tool,
        accept: async (agentId: string, sender: AcceptedSender): Promise<void> => {
            const accepted: AgentBaseAcceptedMessage = {
                id: `message-${String(Math.random())}`,
                kind: "send",
                profile: null,
                message:
                    sender.role === "agent"
                        ? {
                              role: "agent",
                              author: { id: "peeragent", description: "A peer" },
                              content: [{ type: "text", text: "Peer request" }],
                          }
                        : { role: "user", content: [{ type: "text", text: "Hello" }] },
                metadata: {
                    ...(sender.synthetic === true ? {} : { messageOrigin: "user" }),
                    ...(sender.userId === undefined ? {} : { userId: sender.userId }),
                },
            };
            await database.context.inTx(async (ctx) => {
                await taskHooks.messageAcceptedTransact?.(ctx, scopeFor(agentId), accepted);
            });
        },
        executeCreate: async (
            agentId: string,
            input: { readonly name: string; readonly text?: string },
            remembered = new Map<string, unknown>(),
        ): Promise<TaskRecord> =>
            (await (
                await tool(agentId, "create_task")
            ).execute(database.context, input, {
                id: `create-${input.name}`,
                kv: {
                    getOrCreate: async (
                        _ctx: Context,
                        key: string,
                        create: () => unknown,
                    ): Promise<unknown> => {
                        if (!remembered.has(key)) remembered.set(key, await create());
                        return remembered.get(key);
                    },
                },
            } as never)) as TaskRecord,
        taskTools: async (agentId: string): Promise<readonly string[]> =>
            (await taskToolsFor(agentId)).map((candidate) => candidate.name),
        botTools: async (agentId: string): Promise<readonly string[]> =>
            ((await botHooks.tools?.(database.context, scopeFor(agentId))) ?? []).map(
                (candidate) => candidate.name,
            ),
        instructions: async (agentId: string): Promise<string> =>
            [
                (await taskHooks.instructions?.(database.context, scopeFor(agentId))) ?? "",
                (await botHooks.instructions?.(database.context, scopeFor(agentId))) ?? "",
            ]
                .filter((part) => part !== "")
                .join("\n\n"),
        close: async () => {
            await bots.close();
            await titles.close();
            database.close();
            await rm(dirname(config.configuration.paths.publicHome), {
                force: true,
                recursive: true,
            });
        },
    };
}
