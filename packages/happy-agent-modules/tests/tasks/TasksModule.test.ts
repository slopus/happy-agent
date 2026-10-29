import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    AgentProviders,
    withAgentContext,
    type AgentBaseAcceptedMessage,
    type AgentBaseMessageOptions,
    type AgentConfig,
    type AgentKV,
    type AgentModel,
    type AgentModuleScope,
    type AgentPermissionMode,
    type AgentQueuedMessage,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { agentModeFromConfig } from "../../sources/api/ApiResourceProjection.js";
import { botMigrations, BotsModule } from "../../sources/bots/index.js";
import { CollaborationModule } from "../../sources/collaboration/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import {
    DurableFunctionsModule,
    durableFunctionsMigrations,
} from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { ProfileModule } from "../../sources/profile/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import {
    STANDALONE_TASK_MEMBER,
    taskMigrations,
    taskOrderKeySchema,
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
import { TeamModule } from "../../sources/team/index.js";
import { TitlesModule } from "../../sources/titles/index.js";
import { WorkspacesModule, workspaceMigrations } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { sharedKV } from "../support/fixtures.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsCatalogFor } from "../support/projectsModule.js";

const OWNER = "ownerusera1b2c3d4e5f6g7h8";
/** The installation's models; the first is its default. */
const MODELS: readonly AgentModel[] = [
    {
        providerId: "scripted",
        id: "scripted/default",
        name: "Default",
        effortLevels: ["low", "medium"],
        defaultEffort: "medium",
    },
    {
        providerId: "scripted",
        id: "scripted/deep",
        name: "Deep",
        effortLevels: ["medium", "high"],
        defaultEffort: "medium",
        serviceTiers: ["priority"],
    },
];
const OTHER_OWNER = "ownerusero9p8q7r6s5t4u3v2";

class TaskAgents {
    readonly models: readonly AgentModel[] = MODELS;
    readonly configs = new Map<string, AgentConfig>();
    readonly parents = new Map<string, string | null>();
    readonly aborted: string[] = [];
    sendFailure: Error | undefined;
    readonly sent: {
        readonly agentId: string;
        readonly message: AgentQueuedMessage;
        readonly id: string | undefined;
    }[] = [];
    /** The options each message was sent with, by message ID. */
    readonly options = new Map<string, AgentBaseMessageOptions>();

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
        options: AgentBaseMessageOptions = {},
    ) {
        if (this.sendFailure !== undefined) throw this.sendFailure;
        if (!this.configs.has(agentId)) throw new Error("Agent missing.");
        this.sent.push({ agentId, message: structuredClone(message), id: options.id });
        if (options.id !== undefined) this.options.set(options.id, structuredClone(options));
        return { id: options.id ?? "generatedmessage" };
    }

    async steer(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options: AgentBaseMessageOptions = {},
    ) {
        return await this.send(ctx, agentId, message, options);
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

const TASK_REFERENCE_INSTRUCTIONS =
    'When you mention a task in a reply, write <happy-agent id="…"/> with the task\'s agent ID, not its task ID; people see its live name as a link. The task tools give you the exact tag.';
const BOT_REFERENCE_INSTRUCTIONS =
    'When you mention a bot in a reply, write <happy-agent id="…"/> with the bot\'s agent ID, not its bot ID; people see its live name as a link. The bot tools give you the exact tag.';

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
                    "",
                    BOT_REFERENCE_INSTRUCTIONS,
                ].join("\n"),
            );
            // An agent offered the task and bot tools learns how to mention each.
            await expect(fixture.instructions("someoneelsesagent")).resolves.toBe(
                `${TASK_REFERENCE_INSTRUCTIONS}\n\n${BOT_REFERENCE_INSTRUCTIONS}`,
            );
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

    it("deletes an archived task's folder and row for good", async () => {
        const fixture = await started("tasks-purge");
        try {
            const ctx = fixture.database.context;
            const task = await fixture.tasks.create(ctx, { name: "Doomed" });
            await expect(fixture.tasks.purge(ctx, task.id)).rejects.toThrow(
                "Only an archived task can be deleted.",
            );
            expect((await stat(task.path)).isDirectory()).toBe(true);

            const archived = await fixture.tasks.archive(ctx, task.id, task.version);
            fixture.events.length = 0;
            await fixture.tasks.purge(ctx, task.id);

            expect(await fixture.tasks.get(ctx, task.id)).toBeUndefined();
            expect(await fixture.tasks.forAgent(ctx, task.agentId)).toBeUndefined();
            await expect(stat(task.path)).rejects.toMatchObject({ code: "ENOENT" });
            await vi.waitFor(() => {
                expect(fixture.events).toMatchObject([{ type: "task_deleted", task: archived }]);
            });
            await fixture.tasks.purge(ctx, task.id);
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
            expect(text).toContain(`mention it as <happy-agent id=\\"${first.agentId}\\"/>`);
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

    it("runs a task an agent opens on that agent's model, or on the installation default", async () => {
        const fixture = await started("tasks-opening-mode");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Planner" });
            const running = (selection: {
                readonly model: string;
                readonly effort: "low" | "medium" | "high";
                readonly serviceTier?: string;
            }) =>
                withAgentContext(ctx, {
                    id: bot.agentId,
                    provider: "scripted",
                    permissionMode: "full_access",
                    ...selection,
                });

            // The creator's own selection, tier included, opens the task.
            const inherited = await fixture.executeCreate(
                bot.agentId,
                { name: "Deep work", text: "Profile the export job." },
                new Map(),
                running({ model: "scripted/deep", effort: "high", serviceTier: "priority" }),
            );
            const mode = {
                providerId: "scripted",
                modelId: "scripted/deep",
                effort: "high",
                serviceTier: "priority",
                permissionMode: "auto",
            };
            expect(fixture.agents.options.get(inherited.agentId)).toMatchObject({
                provider: "scripted",
                model: "scripted/deep",
                effort: "high",
                serviceTier: "priority",
                permissionMode: "auto",
                metadata: { mode },
            });
            expect(fixture.agents.configs.get(inherited.agentId)?.metadata?.["lastMode"]).toEqual(
                mode,
            );

            // A task that has a mode keeps it: a later message carries no selection.
            await fixture.tasks.sendMessage(
                running({ model: "scripted/default", effort: "low" }),
                bot.agentId,
                inherited.id,
                "Any progress?",
                "followupmessage1",
            );
            const followUp = fixture.agents.options.get("followupmessage1");
            expect(followUp?.model).toBeUndefined();
            expect(followUp?.provider).toBeUndefined();
            expect(followUp?.metadata?.["mode"]).toBeUndefined();
            expect(fixture.agents.configs.get(inherited.agentId)?.metadata?.["lastMode"]).toEqual(
                mode,
            );

            // A model this installation no longer offers falls back to its default model, at
            // that model's default effort and ordinary tier.
            const retired = await fixture.executeCreate(
                bot.agentId,
                { name: "Retired", text: "Keep going." },
                new Map(),
                running({ model: "scripted/retired", effort: "high", serviceTier: "priority" }),
            );
            expect(fixture.agents.options.get(retired.agentId)).toMatchObject({
                provider: "scripted",
                model: "scripted/default",
                effort: "medium",
                serviceTier: null,
                permissionMode: "auto",
            });

            // So does an effort or tier the inherited model does not accept.
            const narrowed = await fixture.executeCreate(
                bot.agentId,
                { name: "Narrowed", text: "Keep going." },
                new Map(),
                running({ model: "scripted/default", effort: "high", serviceTier: "priority" }),
            );
            expect(fixture.agents.options.get(narrowed.agentId)).toMatchObject({
                model: "scripted/default",
                effort: "medium",
                serviceTier: null,
            });
        } finally {
            await fixture.close();
        }
    });

    it("gives a task that never had a mode one with its next message, and never overrides a person's", async () => {
        const fixture = await started("tasks-modeless-repair");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Planner" });
            const botCtx = withAgentContext(ctx, {
                id: bot.agentId,
                provider: "scripted",
                model: "scripted/deep",
                effort: "high",
                permissionMode: "auto",
            });
            // A task created before tasks chose a model: it has no mode at all.
            const modeless = await fixture.tasks.create(ctx, { name: "Modeless" });
            expect(fixture.agents.configs.get(modeless.agentId)?.metadata?.["lastMode"]).toBe(
                undefined,
            );
            await fixture.tasks.sendMessage(botCtx, bot.agentId, modeless.id, "Hello?", "repair1");
            expect(fixture.agents.options.get("repair1")).toMatchObject({
                provider: "scripted",
                model: "scripted/deep",
                effort: "high",
                serviceTier: null,
                permissionMode: "auto",
            });
            expect(fixture.agents.configs.get(modeless.agentId)?.metadata?.["lastMode"]).toEqual({
                providerId: "scripted",
                modelId: "scripted/deep",
                effort: "high",
                serviceTier: null,
                permissionMode: "auto",
            });

            // Without a sender selection at all, the installation default is used.
            const unattended = await fixture.tasks.create(ctx, { name: "Unattended" });
            await fixture.tasks.sendMessage(ctx, bot.agentId, unattended.id, "Hi.", "repair2");
            expect(fixture.agents.options.get("repair2")).toMatchObject({
                model: "scripted/default",
                effort: "medium",
            });

            // A person who already chose a mode keeps it.
            const chosen = await fixture.tasks.create(ctx, { name: "Chosen" });
            const personal = {
                providerId: "scripted",
                modelId: "scripted/default",
                effort: "low",
                serviceTier: null,
                permissionMode: "read_only",
            };
            await fixture.agents.updateMetadata(ctx, chosen.agentId, { lastMode: personal });
            await fixture.tasks.sendMessage(botCtx, bot.agentId, chosen.id, "Status?", "kept1");
            expect(fixture.agents.options.get("kept1")?.model).toBeUndefined();
            expect(fixture.agents.configs.get(chosen.agentId)?.metadata?.["lastMode"]).toEqual(
                personal,
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
            expect(renamed).toMatchObject({
                name: "Renamed",
                nameConfigured: true,
                folderName: "first",
                version: 2,
            });
            expect(fixture.agents.configs.get(first.agentId)?.metadata?.title).toBe("Renamed");
            await expect(
                fixture.tasks.rename(fixture.database.context, first.id, "Stale", first.version),
            ).rejects.toBeInstanceOf(TaskConflictError);
        } finally {
            await fixture.close();
        }
    });

    it("names an unnamed task once from its first message, and lets a rename win", async () => {
        const fixture = await started("tasks-naming");
        try {
            const ctx = fixture.database.context;
            fixture.naming.mockResolvedValue({ title: "Fix the login redirect loop" });
            const unnamed = await fixture.tasks.create(ctx, {});
            expect(unnamed).toMatchObject({
                name: "New Task",
                nameConfigured: false,
                folderName: "task",
            });
            expect(fixture.agents.configs.get(unnamed.agentId)?.metadata?.title).toBe("New Task");

            await fixture.acceptText(unnamed.agentId, "user", "The login page loops forever.");
            await vi.waitFor(async () => {
                expect((await fixture.tasks.get(ctx, unnamed.id))?.name).toBe(
                    "Fix the login redirect loop",
                );
            });
            const named = (await fixture.tasks.get(ctx, unnamed.id))!;
            expect(named).toMatchObject({ nameConfigured: true, folderName: "task" });
            expect(fixture.agents.configs.get(unnamed.agentId)?.metadata?.title).toBe(
                "Fix the login redirect loop",
            );
            expect(fixture.naming).toHaveBeenCalledTimes(1);
            expect(fixture.naming.mock.calls[0]?.[1]).toMatchObject({
                firstMessage: "The login page loops forever.",
                wanted: { title: true },
                providerId: "scripted",
            });
            // Later messages never ask again.
            await fixture.acceptText(unnamed.agentId, "user", "Also check the logout page.");
            expect(fixture.naming).toHaveBeenCalledTimes(1);

            // A create_task opening message names the task without its sender line.
            const opened = await fixture.tasks.create(ctx, {});
            await fixture.acceptText(
                opened.agentId,
                "agent",
                "Message from agent botagent:\n\nAudit the billing exports.",
                { tasks: { fromAgentId: "botagent", taskId: opened.id } },
            );
            await vi.waitFor(() => expect(fixture.naming).toHaveBeenCalledTimes(2));
            expect(fixture.naming.mock.calls[1]?.[1]).toMatchObject({
                firstMessage: "Audit the billing exports.",
            });

            // A named task is never renamed automatically.
            const chosen = await fixture.tasks.create(ctx, { name: "Chosen" });
            await fixture.acceptText(chosen.agentId, "user", "Anything at all.");
            expect(fixture.naming).toHaveBeenCalledTimes(2);

            // A rename committed while naming runs is the name that stays.
            let answer!: (names: { title?: string }) => void;
            fixture.naming.mockReturnValueOnce(
                new Promise((resolve) => {
                    answer = resolve;
                }),
            );
            const raced = await fixture.tasks.create(ctx, {});
            await fixture.acceptText(raced.agentId, "user", "Rewrite the onboarding emails.");
            await vi.waitFor(() => expect(fixture.naming).toHaveBeenCalledTimes(3));
            await fixture.tasks.rename(ctx, raced.id, "Onboarding emails", raced.version);
            answer({ title: "Generated name" });
            await fixture.tasks.close();
            expect((await fixture.tasks.get(ctx, raced.id))?.name).toBe("Onboarding emails");
            expect(fixture.agents.configs.get(raced.agentId)?.metadata?.title).toBe(
                "Onboarding emails",
            );
        } finally {
            await fixture.close();
        }
    });

    it("leaves a previously attempted unnamed task alone", async () => {
        const fixture = await started("tasks-old-name-attempt");
        try {
            const task = await fixture.tasks.create(fixture.database.context, {});
            await fixture.markNamingAttempted(task.agentId);
            await fixture.acceptText(task.agentId, "user", "A new follow-up message.");
            expect(fixture.naming).not.toHaveBeenCalled();
            expect((await fixture.tasks.get(fixture.database.context, task.id))?.name).toBe(
                "New Task",
            );
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

    it("keeps joining new tasks at the top of a long list", async () => {
        const fixture = await started("tasks-long-list");
        try {
            const ctx = fixture.database.context;
            const names: string[] = [];
            for (let index = 0; index < 300; index++) {
                const name = `Task ${index}`;
                await fixture.tasks.create(ctx, { name });
                names.unshift(name);
            }
            const listed = await fixture.tasks.listForMember(ctx, STANDALONE_TASK_MEMBER);
            expect(listed.map(({ task }) => task.name)).toEqual(names);
            const longest = Math.max(...listed.map(({ membership }) => membership.orderKey.length));
            expect(longest).toBeLessThanOrEqual(8);
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

    it("loops a member into a task as unread, keeps their place if already in, and clears it when read", async () => {
        const fixture = await started("tasks-loop-in", { team: true });
        try {
            const ctx = fixture.database.context;
            const task = await fixture.tasks.create(ctx, { name: "Shared", ownerUserId: OWNER });
            // An explicit leave does not keep someone out once an agent loops them back in.
            await fixture.tasks.join(ctx, task.id, OTHER_OWNER);
            await fixture.tasks.leave(ctx, task.id, OTHER_OWNER);
            fixture.events.length = 0;

            const looped = await fixture.tasks.loopIn(ctx, task.id, OTHER_OWNER, {
                agentId: "loopingagent1",
                note: "Steve owns the billing service this touches.",
            });
            expect(looped).toMatchObject({
                joined: true,
                membership: {
                    taskId: task.id,
                    memberId: OTHER_OWNER,
                    unread: {
                        reason: "looped_in",
                        agentId: "loopingagent1",
                        note: "Steve owns the billing service this touches.",
                    },
                },
            });
            await expect(fixture.tasks.membership(ctx, task.id, OTHER_OWNER)).resolves.toEqual(
                looped.membership,
            );

            // Looping in again re-marks the task without moving it in their list.
            const again = await fixture.tasks.loopIn(ctx, task.id, OTHER_OWNER, {
                agentId: "loopingagent1",
                note: "The migration needs a second look.",
            });
            expect(again.joined).toBe(false);
            expect(again.membership.orderKey).toBe(looped.membership.orderKey);
            expect(again.membership.unread?.note).toBe("The migration needs a second look.");

            const read = await fixture.tasks.markRead(ctx, task.id, OTHER_OWNER);
            expect(read).toEqual({ ...looped.membership, unread: undefined });
            expect(read).not.toHaveProperty("unread");
            await expect(fixture.tasks.markRead(ctx, task.id, OTHER_OWNER)).resolves.toEqual(read);
            await expect(fixture.tasks.markRead(ctx, task.id, OWNER)).resolves.not.toHaveProperty(
                "unread",
            );
            expect(fixture.events.map((event) => event.type)).toEqual([
                "task_joined",
                "task_membership_updated",
                "task_membership_updated",
            ]);

            // A blank or oversized reason, and archived tasks, are refused.
            await expect(
                fixture.tasks.loopIn(ctx, task.id, OWNER, { agentId: "loopingagent1", note: " " }),
            ).rejects.toBeInstanceOf(TaskInputError);
            await expect(
                fixture.tasks.loopIn(ctx, task.id, OWNER, {
                    agentId: "loopingagent1",
                    note: "x".repeat(501),
                }),
            ).rejects.toBeInstanceOf(TaskInputError);
            const current = (await fixture.tasks.get(ctx, task.id))!;
            await fixture.tasks.archive(ctx, task.id, current.version);
            await expect(
                fixture.tasks.loopIn(ctx, task.id, OTHER_OWNER, {
                    agentId: "loopingagent1",
                    note: "Too late.",
                }),
            ).rejects.toBeInstanceOf(TaskConflictError);
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

    it("creates a task with model selection and opening text, stamping the chosen mode on the message", async () => {
        const fixture = await started("tasks-create-model-text");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            const task = await fixture.executeCreate(bot.agentId, {
                name: "Task With Model",
                text: "Start working with deep model",
                model: "scripted/deep",
                effort: "high",
                serviceTier: "priority",
            });
            expect(task.name).toBe("Task With Model");

            const sent = fixture.agents.sent.find((entry) => entry.agentId === task.agentId);
            expect(sent).toBeDefined();
            expect(sent?.id).toBe(task.agentId);
            const options = fixture.agents.options.get(task.agentId);
            expect(options).toMatchObject({
                model: "scripted/deep",
                effort: "high",
                provider: "scripted",
                serviceTier: "priority",
                permissionMode: "auto",
            });
            expect(options?.metadata).toMatchObject({
                mode: {
                    modelId: "scripted/deep",
                    effort: "high",
                    providerId: "scripted",
                    serviceTier: "priority",
                    permissionMode: "auto",
                },
            });

            const config = fixture.agents.configs.get(task.agentId);
            expect(config?.metadata?.["lastMode"]).toEqual({
                modelId: "scripted/deep",
                effort: "high",
                providerId: "scripted",
                serviceTier: "priority",
                permissionMode: "auto",
            });
        } finally {
            await fixture.close();
        }
    });

    it("never opens a task an agent creates in a mode wider than that agent's own", async () => {
        const fixture = await started("tasks-create-permission-cap");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            const running = (permissionMode: AgentPermissionMode) => {
                fixture.scopeModes.set(bot.agentId, permissionMode);
                return withAgentContext(ctx, {
                    id: bot.agentId,
                    provider: "scripted",
                    model: "scripted/deep",
                    effort: "high",
                    permissionMode,
                });
            };
            const opened = async (
                name: string,
                permissionMode: AgentPermissionMode,
                model?: string,
            ) => {
                const task = await fixture.executeCreate(
                    bot.agentId,
                    {
                        name,
                        text: "Start.",
                        ...(model === undefined ? {} : { model, effort: "high" }),
                    },
                    new Map(),
                    running(permissionMode),
                );
                return fixture.agents.options.get(task.agentId)?.permissionMode;
            };

            // Chosen model or inherited one, a narrower creator narrows the task.
            expect(await opened("Read only chosen", "read_only", "scripted/deep")).toBe(
                "read_only",
            );
            expect(await opened("Read only inherited", "read_only")).toBe("read_only");
            expect(await opened("Workspace chosen", "workspace_write", "scripted/deep")).toBe(
                "workspace_write",
            );
            // A wider creator does not widen a task past the product default.
            expect(await opened("Full chosen", "full_access", "scripted/deep")).toBe("auto");
            expect(await opened("Full inherited", "full_access")).toBe("auto");
        } finally {
            await fixture.close();
        }
    });

    it("creates an idle task with model selection, seeding draft and initialMode while keeping lastMode null", async () => {
        const fixture = await started("tasks-create-idle-model");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            const task = await fixture.executeCreate(bot.agentId, {
                name: "Idle Deep Task",
                model: "scripted/deep",
                effort: "high",
            });
            expect(task.name).toBe("Idle Deep Task");

            const sent = fixture.agents.sent.filter((entry) => entry.agentId === task.agentId);
            expect(sent).toHaveLength(0);

            const config = fixture.agents.configs.get(task.agentId);
            expect(config?.metadata?.["draft"]).toEqual({
                modelId: "scripted/deep",
                effort: "high",
                providerId: "scripted",
                serviceTier: null,
                permissionMode: "auto",
                text: "",
            });
            expect(typeof config?.metadata?.["draftUpdatedAt"]).toBe("number");
            expect(config?.metadata?.["initialMode"]).toEqual({
                modelId: "scripted/deep",
                effort: "high",
                providerId: "scripted",
                serviceTier: null,
                permissionMode: "auto",
            });
            expect(config?.metadata?.["lastMode"]).toBeUndefined();
            expect(agentModeFromConfig(config!)).toBeNull();
            expect(config?.metadata?.["unstarted"]).toBeUndefined();
        } finally {
            await fixture.close();
        }
    });

    it("seeds the owner's team draft atomically on idle task creation without touching other users or overwriting newer drafts", async () => {
        const fixture = await started("tasks-create-idle-team-draft", { team: true });
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            await fixture.accept(bot.agentId, { role: "user", userId: OWNER });

            const task = await fixture.executeCreate(bot.agentId, {
                name: "Team Idle Task",
                model: "scripted/deep",
                effort: "high",
                serviceTier: "priority",
            });

            const config = fixture.agents.configs.get(task.agentId);
            expect(config?.metadata?.["draft"]).toBeUndefined();
            expect(config?.metadata?.["lastMode"]).toBeUndefined();
            expect(agentModeFromConfig(config!)).toBeNull();
            expect(config?.metadata?.["initialMode"]).toEqual({
                modelId: "scripted/deep",
                effort: "high",
                providerId: "scripted",
                serviceTier: "priority",
                permissionMode: "auto",
            });

            const ownerDraft = await fixture.team.draft(ctx, task.agentId, OWNER);
            expect(ownerDraft).toEqual({
                value: {
                    modelId: "scripted/deep",
                    effort: "high",
                    providerId: "scripted",
                    serviceTier: "priority",
                    permissionMode: "auto",
                    text: "",
                },
                updatedAt: task.createdAt,
            });
            const otherDraft = await fixture.team.draft(ctx, task.agentId, OTHER_OWNER);
            expect(otherDraft).toEqual({ value: null, updatedAt: null });

            // A pre-existing user draft is never overwritten when task_created seeding runs.
            const preseededAgentId = "preseededagent1234567890";
            await fixture.team.saveDraft(ctx, preseededAgentId, OWNER, {
                draft: {
                    modelId: "scripted/default",
                    effort: "low",
                    providerId: "scripted",
                    serviceTier: null,
                    permissionMode: "read_only",
                    text: "Working on this",
                },
                updatedAt: task.createdAt + 100,
            });
            await fixture.tasks.create(ctx, {
                agentId: preseededAgentId,
                name: "Preseeded Draft Task",
                ownerUserId: OWNER,
                mode: {
                    modelId: "scripted/deep",
                    effort: "high",
                    providerId: "scripted",
                    serviceTier: "priority",
                    permissionMode: "auto",
                },
            });
            expect(await fixture.team.draft(ctx, preseededAgentId, OWNER)).toEqual({
                value: {
                    modelId: "scripted/default",
                    effort: "low",
                    providerId: "scripted",
                    serviceTier: null,
                    permissionMode: "read_only",
                    text: "Working on this",
                },
                updatedAt: task.createdAt + 100,
            });

            // If a transactional listener aborts task creation, the seeded team draft rolls back with it.
            const rolledBackAgentId = "rolledbackagent1234567890";
            const stop = fixture.tasks.onEventTransactional((_txCtx, event) => {
                if (
                    event.type === "task_joined" &&
                    event.membership.taskId === "rolledbacktask1234567890"
                ) {
                    throw new Error("Simulated creation rollback");
                }
            });
            await expect(
                fixture.tasks.create(ctx, {
                    id: "rolledbacktask1234567890",
                    agentId: rolledBackAgentId,
                    name: "Rolled Back Task",
                    ownerUserId: OWNER,
                    mode: {
                        modelId: "scripted/deep",
                        effort: "high",
                        providerId: "scripted",
                        serviceTier: null,
                        permissionMode: "auto",
                    },
                }),
            ).rejects.toThrow("Simulated creation rollback");
            stop();
            expect(await fixture.team.draft(ctx, rolledBackAgentId, OWNER)).toEqual({
                value: null,
                updatedAt: null,
            });
        } finally {
            await fixture.close();
        }
    });

    it("preserves initialMode across failed sends and draft edits, then records lastMode and clears initialMode on first accepted message", async () => {
        const fixture = await started("tasks-idle-followup-preservation");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            const task = await fixture.executeCreate(bot.agentId, {
                name: "Idle Deep Task",
                model: "scripted/deep",
                effort: "high",
            });

            // Editing the composer draft never changes the immutable creation choice or grants permissions.
            await fixture.agents.updateMetadata(ctx, task.agentId, {
                draft: {
                    modelId: "scripted/default",
                    effort: "low",
                    providerId: "scripted",
                    serviceTier: null,
                    permissionMode: "full_access",
                    text: "Unsent user draft",
                },
                draftUpdatedAt: Date.now() + 1000,
            });

            // A rejected/failed send must not consume initialMode or write lastMode.
            const sendTool = await fixture.tool(bot.agentId, "send_task_message");
            fixture.agents.sendFailure = new Error("Simulated delivery failure");
            await expect(
                sendTool.execute(ctx, { taskId: task.id, text: "Failed attempt" }, {
                    id: "send-failed",
                    kv: { getOrCreate: async () => "msg-failed" },
                } as never),
            ).rejects.toThrow("Simulated delivery failure");
            fixture.agents.sendFailure = undefined;

            const afterFailed = fixture.agents.configs.get(task.agentId);
            expect(afterFailed?.metadata?.["lastMode"]).toBeUndefined();
            expect(afterFailed?.metadata?.["initialMode"]).toEqual({
                modelId: "scripted/deep",
                effort: "high",
                providerId: "scripted",
                serviceTier: null,
                permissionMode: "auto",
            });

            await sendTool.execute(ctx, { taskId: task.id, text: "Follow-up instructions" }, {
                id: "send-1",
                kv: { getOrCreate: async () => "msg-1" },
            } as never);

            const options = fixture.agents.options.get("send-1");
            expect(options).toMatchObject({
                model: "scripted/deep",
                effort: "high",
                provider: "scripted",
                serviceTier: null,
                permissionMode: "auto",
            });
            expect(options?.metadata).toMatchObject({
                mode: {
                    modelId: "scripted/deep",
                    effort: "high",
                    providerId: "scripted",
                    serviceTier: null,
                    permissionMode: "auto",
                },
            });

            const config = fixture.agents.configs.get(task.agentId);
            expect(config?.metadata?.["lastMode"]).toEqual({
                modelId: "scripted/deep",
                effort: "high",
                providerId: "scripted",
                serviceTier: null,
                permissionMode: "auto",
            });
            expect(config?.metadata?.["initialMode"]).toBeNull();
            expect(config?.metadata?.["unstarted"]).toBeUndefined();

            // A subsequent agent message to the now-started task carries no model override and issues no metadata write.
            const versionAfterFirst = config?.metadata?.["version"];
            const updateMetadataSpy = vi.spyOn(fixture.agents, "updateMetadata");
            await sendTool.execute(ctx, { taskId: task.id, text: "Second message" }, {
                id: "send-2",
                kv: { getOrCreate: async () => "msg-2" },
            } as never);
            expect(updateMetadataSpy).not.toHaveBeenCalled();
            updateMetadataSpy.mockRestore();
            expect(fixture.agents.configs.get(task.agentId)?.metadata?.["version"]).toBe(
                versionAfterFirst,
            );
            const secondOptions = fixture.agents.options.get("send-2");
            expect(secondOptions?.model).toBeUndefined();
            expect(secondOptions?.provider).toBeUndefined();
            expect(secondOptions?.metadata?.["mode"]).toBeUndefined();

            // Collaboration sendMessage (steer) and human explicit lastMode also consume initialMode cleanly.
            const steeredTask = await fixture.executeCreate(bot.agentId, {
                name: "Steered Idle Task",
                model: "scripted/deep",
                effort: "high",
            });
            await fixture.collaboration.sendMessage(
                ctx,
                bot.agentId,
                { toAgentId: steeredTask.agentId, text: "Steered opening" },
                "steer-1",
            );
            expect(fixture.agents.options.get("steer-1")).toMatchObject({
                model: "scripted/deep",
                effort: "high",
                provider: "scripted",
                serviceTier: null,
                permissionMode: "auto",
            });
            expect(fixture.agents.configs.get(steeredTask.agentId)?.metadata?.["lastMode"]).toEqual(
                {
                    modelId: "scripted/deep",
                    effort: "high",
                    providerId: "scripted",
                    serviceTier: null,
                    permissionMode: "auto",
                },
            );
            expect(
                fixture.agents.configs.get(steeredTask.agentId)?.metadata?.["initialMode"],
            ).toBeNull();
        } finally {
            await fixture.close();
        }
    });

    it("rejects invalid model or effort combinations in create_task", async () => {
        const fixture = await started("tasks-create-validation");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });

            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Bad Model",
                    model: "scripted/unknown",
                    effort: "high",
                }),
            ).rejects.toThrow('Model "scripted/unknown" is not available');

            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Bad Effort",
                    model: "scripted/deep",
                    effort: "low",
                }),
            ).rejects.toThrow(
                'Effort "low" is not available for collaborator model "scripted/deep".',
            );

            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Missing Effort",
                    model: "scripted/deep",
                }),
            ).rejects.toThrow("Effort is required when a model is selected.");

            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Missing Model",
                    effort: "high",
                }),
            ).rejects.toThrow(
                "A model must be selected to specify effort, harness, provider, or service tier.",
            );
        } finally {
            await fixture.close();
        }
    });

    it("rejects provider mismatch, unavailable service tiers, and non-serving harnesses", async () => {
        const fixture = await started("tasks-create-resolver-checks");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });

            // Provider mismatch: model exists, but not from this provider
            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Wrong Provider",
                    model: "scripted/deep",
                    effort: "high",
                    provider: "nonexistent",
                }),
            ).rejects.toThrow(
                'Model "scripted/deep" is not available from provider "nonexistent".',
            );

            // Service tier not offered on model
            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Unsupported Tier",
                    model: "scripted/default",
                    effort: "medium",
                    serviceTier: "priority",
                }),
            ).rejects.toThrow(
                'Service tier "priority" is not available for collaborator model "scripted/default".',
            );

            // Harness that does not run this model
            await expect(
                fixture.executeCreate(bot.agentId, {
                    name: "Wrong Harness",
                    model: "scripted/deep",
                    effort: "high",
                    harness: "disabled-harness",
                }),
            ).rejects.toThrow('Model "scripted/deep" does not run on harness "disabled-harness"');
        } finally {
            await fixture.close();
        }
    });

    it("throws an actionable error when an explicitly chosen initial model, effort, or service tier is no longer offered", async () => {
        const fixture = await started("tasks-model-retired");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            const task = await fixture.executeCreate(bot.agentId, {
                name: "Retired Model Task",
                model: "scripted/deep",
                effort: "high",
                serviceTier: "priority",
            });

            // 1. Model retired from catalog
            const withoutDeep = await fixture.tasksWithModels([MODELS[0]!]);
            await expect(
                withoutDeep.sendMessage(
                    ctx,
                    bot.agentId,
                    task.id,
                    "Follow-up after model retired",
                    "send-retired-model",
                ),
            ).rejects.toThrow(
                'The model "scripted/deep" from provider "scripted" chosen at task creation is no longer available.',
            );
            expect(
                fixture.agents.configs.get(task.agentId)?.metadata?.["lastMode"],
            ).toBeUndefined();
            expect(
                fixture.agents.configs.get(task.agentId)?.metadata?.["initialMode"],
            ).toBeDefined();

            // 2. Effort retired from model
            const withoutHighEffort = await fixture.tasksWithModels([
                MODELS[0]!,
                {
                    providerId: "scripted",
                    id: "scripted/deep",
                    name: "Deep",
                    effortLevels: ["medium"],
                    defaultEffort: "medium",
                    serviceTiers: ["priority"],
                },
            ]);
            await expect(
                withoutHighEffort.sendMessage(
                    ctx,
                    bot.agentId,
                    task.id,
                    "Follow-up after effort retired",
                    "send-retired-effort",
                ),
            ).rejects.toThrow(
                'The effort "high" chosen at task creation is no longer available for model "scripted/deep".',
            );

            // 3. Service tier retired from model
            const withoutPriorityTier = await fixture.tasksWithModels([
                MODELS[0]!,
                {
                    providerId: "scripted",
                    id: "scripted/deep",
                    name: "Deep",
                    effortLevels: ["medium", "high"],
                    defaultEffort: "medium",
                },
            ]);
            await expect(
                withoutPriorityTier.sendMessage(
                    ctx,
                    bot.agentId,
                    task.id,
                    "Follow-up after tier retired",
                    "send-retired-tier",
                ),
            ).rejects.toThrow(
                'The service tier "priority" chosen at task creation is no longer available for model "scripted/deep".',
            );

            // 4. Legacy task with no explicit creation choice still falls back to default model
            const unchosen = await fixture.executeCreate(bot.agentId, {
                name: "Unchosen Idle Task",
            });
            const senderOnRetired = withAgentContext(ctx, {
                id: bot.agentId,
                provider: "scripted",
                model: "scripted/deep",
                effort: "high",
                permissionMode: "auto",
            });
            await withoutDeep.sendMessage(
                senderOnRetired,
                bot.agentId,
                unchosen.id,
                "First message to task without explicit model choice",
                "send-legacy-fallback",
            );
            expect(fixture.agents.options.get("send-legacy-fallback")).toMatchObject({
                model: "scripted/default",
                effort: "medium",
                provider: "scripted",
            });
        } finally {
            await fixture.close();
        }
    });

    it("preserves backward compatibility when model is omitted", async () => {
        const fixture = await started("tasks-create-omitted-model");
        try {
            const ctx = fixture.database.context;
            const bot = await fixture.bots.create(ctx, { name: "Creator" });
            const task = await fixture.executeCreate(bot.agentId, {
                name: "Legacy Task",
                text: "Opening message without explicit model",
            });
            expect(task.name).toBe("Legacy Task");

            const options = fixture.agents.options.get(task.agentId);
            expect(options).toMatchObject({
                model: "scripted/default",
                effort: "medium",
                provider: "scripted",
            });
            const config = fixture.agents.configs.get(task.agentId);
            expect(config?.metadata?.["lastMode"]).toMatchObject({
                modelId: "scripted/default",
                effort: "medium",
                providerId: "scripted",
            });
            expect(config?.metadata?.["draft"]).toBeUndefined();
        } finally {
            await fixture.close();
        }
    });

    it("keeps tasks named before automatic naming existed as chosen names", async () => {
        const database = moduleDatabase(taskMigrations.slice(0, 3), "tasks-naming-migration");
        try {
            await database.ready;
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO ${sql.raw(TASKS_TABLE)} (
                    id, name, folder_name, workspace_id, workspace_version, workspace_updated_at,
                    agent_id, path, status, version, created_at, updated_at
                ) VALUES (
                    'releasedtask', 'Released', 'released', 'releasedworkspace', 1, 1,
                    'releasedagent', '/tasks/released', 'active', 1, 1, 1
                )`,
            );
            const [, migrate] = taskMigrations[3];
            await migrate(database.context, database.database);
            const rows = await agentDatabaseRows<{ readonly name_configured: number }>(
                database.database,
                sql`SELECT name_configured FROM ${sql.raw(TASKS_TABLE)}`,
            );
            expect(rows.map((row) => Number(row.name_configured))).toEqual([1]);
        } finally {
            database.close();
        }
    });

    it("renumbers member lists whose keys grew long, keeping their order", async () => {
        const database = moduleDatabase(taskMigrations.slice(0, 5), "tasks-order-key-migration");
        try {
            await database.ready;
            // Two hundred joins at the top, as released builds keyed them, the last one too long
            // to load; and a short list that needs nothing.
            const grown: string[] = ["5", "2", "1"];
            for (let zeros = 1; grown.length < 200; zeros++)
                for (const digit of ["5", "2", "1"]) grown.push(`${"0".repeat(zeros)}${digit}`);
            grown.push(`${"0".repeat(69)}1`);
            const insert = async (member: string, keys: readonly string[]) => {
                for (const [index, key] of keys.entries())
                    await agentDatabaseRun(
                        database.database,
                        sql`INSERT INTO ${sql.raw(TASK_MEMBERS_TABLE)}
                            (task_id, member_id, order_key, joined_at)
                            VALUES (${`${member}task${index}`}, ${member}, ${key}, ${index})`,
                    );
            };
            await insert("standalone", grown);
            await insert(OWNER, ["5", "7"]);
            const list = async (member: string) =>
                await agentDatabaseRows<{ readonly task_id: string; readonly order_key: string }>(
                    database.database,
                    sql`SELECT task_id, order_key FROM ${sql.raw(TASK_MEMBERS_TABLE)}
                        WHERE member_id = ${member} ORDER BY order_key, task_id`,
                );
            const before = (await list("standalone")).map((row) => row.task_id);

            const [key, migrate] = taskMigrations[5];
            expect(key).toBe("006-task-order-keys-renumbered");
            await migrate(database.context, database.database);
            await migrate(database.context, database.database);

            const after = await list("standalone");
            expect(after.map((row) => row.task_id)).toEqual(before);
            expect(Math.max(...after.map((row) => row.order_key.length))).toBeLessThanOrEqual(4);
            for (const row of after)
                expect(Value.Check(taskOrderKeySchema, row.order_key)).toBe(true);
            expect((await list(OWNER)).map((row) => row.order_key)).toEqual(["5", "7"]);
        } finally {
            database.close();
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
                "004-task-naming",
                "005-task-explicit-leaves",
                "006-task-order-keys-renumbered",
                "007-task-member-unread",
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

async function started(
    name: string,
    options: { readonly team?: boolean; readonly models?: readonly AgentModel[] } = {},
) {
    const configToml = [
        "[providers.scripted]",
        'type = "codex"',
        "enabled = true",
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
    ].join("\n");
    const config = await temporaryTestConfig(configToml, {
        inference: { models: options.models ?? MODELS, providers: new AgentProviders() },
    });
    const extraHomes: string[] = [];
    const extraTasks: TasksModule[] = [];
    const teamMigrations = new TeamModule(config, new ProfileModule(config, undefined as never))
        .migrations;
    const database = moduleDatabase(
        [
            ...projectMigrations,
            ...workspaceMigrations,
            ...botMigrations,
            ...taskMigrations,
            ...teamMigrations,
            ...durableFunctionsMigrations,
        ],
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
    const durable = new DurableFunctionsModule();
    vi.spyOn(durable, "invoke");
    vi.spyOn(durable, "cancel");
    const durableHooks = durable.beforeStart(database.context);
    const titles = new TitlesModule(config, new HistoryModule(), workspaces);
    const naming = vi.spyOn(titles, "suggestNames");
    const collaboration = new CollaborationModule(config, abort, new HistoryModule(), compute);
    collaboration.beforeStart(database.context, agents.asRef());
    const tasks = new TasksModule(
        config,
        abort,
        titles,
        projects,
        workspaces,
        runners,
        compute,
        durable as unknown as DurableFunctionsModule,
        collaboration,
    );
    const taskHooks = tasks.beforeStart(database.context, agents.asRef());
    const bots = new BotsModule(
        config,
        abort,
        titles,
        projects,
        workspaces,
        runners,
        tasks,
        durable,
    );
    const botHooks = await bots.beforeStart(database.context, agents.asRef());
    await durableHooks.afterStart?.(database.context, agents.asRef());
    const profile = new ProfileModule(config, bots);
    const team = new TeamModule(config, profile, tasks);
    team.beforeStart(database.context, agents.asRef());
    const events: TaskEvent[] = [];
    tasks.onEvent((_ctx, event) => {
        events.push(event);
    });
    const kvs = new Map<string, AgentKV>();
    // The persistent mode each agent runs in, as Agent Base puts it on every module scope.
    const scopeModes = new Map<string, AgentPermissionMode>();
    const scopeFor = (agentId: string): AgentModuleScope => {
        const kv = kvs.get(agentId) ?? sharedKV();
        kvs.set(agentId, kv);
        return {
            agent: {
                id: agentId,
                provider: "scripted",
                model: "scripted/default",
                permissionMode: scopeModes.get(agentId) ?? "auto",
            },
            kv,
        } as AgentModuleScope;
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
        collaboration,
        scopeModes,
        config,
        database,
        durable,
        events,
        naming,
        markNamingAttempted: async (agentId: string) => {
            await scopeFor(agentId).kv.write(database.context, "task-name-attempted", { at: 1 });
        },
        tasks,
        team,
        tool,
        tasksWithModels: async (nextModels: readonly AgentModel[]): Promise<TasksModule> => {
            const nextConfig = await temporaryTestConfig(configToml, {
                inference: { models: nextModels, providers: new AgentProviders() },
            });
            extraHomes.push(dirname(nextConfig.configuration.paths.publicHome));
            const nextCollaboration = new CollaborationModule(
                nextConfig,
                abort,
                new HistoryModule(),
                compute,
            );
            nextCollaboration.beforeStart(database.context, agents.asRef());
            const nextTasks = new TasksModule(
                nextConfig,
                abort,
                titles,
                projects,
                workspaces,
                runners,
                compute,
                {
                    register: vi.fn(),
                    invoke: vi.fn(),
                    cancel: vi.fn(),
                } as unknown as DurableFunctionsModule,
                nextCollaboration,
            );
            nextTasks.beforeStart(database.context, agents.asRef());
            extraTasks.push(nextTasks);
            return nextTasks;
        },
        acceptText: async (
            agentId: string,
            role: "user" | "agent",
            text: string,
            metadata: NonNullable<AgentBaseAcceptedMessage["metadata"]> = {},
        ): Promise<void> => {
            const accepted: AgentBaseAcceptedMessage = {
                id: `message-${String(Math.random())}`,
                kind: "send",
                profile: null,
                message:
                    role === "agent"
                        ? {
                              role: "agent",
                              author: { id: "botagent", description: "Agent botagent" },
                              content: [{ type: "text", text }],
                          }
                        : { role: "user", content: [{ type: "text", text }] },
                metadata: role === "user" ? { messageOrigin: "user", ...metadata } : metadata,
            };
            await database.context.inTx(async (ctx) => {
                await taskHooks.messageAcceptedTransact?.(ctx, scopeFor(agentId), accepted);
            });
        },
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
            input: {
                readonly name?: string;
                readonly text?: string;
                readonly model?: string;
                readonly effort?: string;
                readonly harness?: string;
                readonly provider?: string;
                readonly serviceTier?: string;
            },
            remembered = new Map<string, unknown>(),
            ctx: Context = database.context,
        ): Promise<TaskRecord> =>
            (await (
                await tool(agentId, "create_task")
            ).execute(ctx, input, {
                id: `create-${input.name ?? "unnamed"}`,
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
            durable.stop();
            for (const extra of extraTasks) await extra.close();
            team.close();
            await tasks.close();
            await bots.close();
            await titles.close();
            database.close();
            for (const home of [dirname(config.configuration.paths.publicHome), ...extraHomes]) {
                await rm(home, {
                    force: true,
                    recursive: true,
                });
            }
        },
    };
}
