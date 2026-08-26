import { describe, expect, it } from "vitest";

import {
    type ProjectEvent,
    projectMigrations,
    ProjectsModule,
} from "../../sources/projects/index.js";
import { GitModule } from "../../sources/git/index.js";
import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsModuleFor } from "../support/projectsModule.js";

describe("project lifecycle event versions", () => {
    it("carries the exact preceding project through sequential updates", async () => {
        const database = moduleDatabase(
            [...durableFunctionsMigrations, ...projectMigrations],
            "project-event-version-chain",
        );
        await database.ready;
        try {
            const projects = projectsModuleFor(await temporaryTestConfig(), new GitModule());
            const events: ProjectEvent[] = [];
            projects.onEventTransactional((_ctx, event) => {
                events.push(event);
            });

            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/event-version-chain",
                name: "Original",
            });
            const renamed = await projects.rename(database.context, {
                expectedVersion: created.version,
                name: "Renamed",
                projectId: created.id,
            });
            const settings = await projects.updateSettings(database.context, {
                expectedVersion: renamed.version,
                projectId: created.id,
                settings: { defaultWorkspaceCompute: { type: "local" } },
            });
            const configured = await projects.get(database.context, created.id);
            if (configured === undefined) {
                throw new Error("The project disappeared after its settings were updated.");
            }
            expect(settings.version).toBe(configured.version);
            const archived = await projects.archive(database.context, created.id);
            const restored = await projects.restore(database.context, created.id);

            expect(events.map((event) => event.type)).toEqual([
                "project_created",
                "project_renamed",
                "project_settings_updated",
                "project_archived",
                "project_restored",
            ]);
            expect(events[0]).toMatchObject({ project: created });
            expectProjectUpdateChain(events[1]!, created, renamed);
            expectProjectUpdateChain(events[2]!, renamed, configured);
            expectProjectUpdateChain(events[3]!, configured, archived);
            expectProjectUpdateChain(events[4]!, archived, restored);
        } finally {
            database.close();
        }
    });

    it("versions and announces every durable root-agent catalog change", async () => {
        const database = moduleDatabase(projectMigrations, "project-agent-event-version-chain");
        await database.ready;
        try {
            const config = await temporaryTestConfig();
            const projects = projectsModuleFor(config, new GitModule());
            projects.beforeStart(database.context, {
                parentOf: async () => null,
            } as never);
            const events: ProjectEvent[] = [];
            projects.onEventTransactional((_ctx, event) => {
                events.push(event);
            });

            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/agent-event-version-chain",
                name: "Agent versions",
            });
            await projects.attachAgent(database.context, created.id, "agent-one");
            const attached = await requiredProject(projects, database.context, created.id);
            await projects.attachAgent(database.context, created.id, "agent-one");
            expect(await requiredProject(projects, database.context, created.id)).toEqual(attached);

            await projects.attachAgent(database.context, created.id, "agent-two");
            const secondAttached = await requiredProject(projects, database.context, created.id);
            await projects.reorderAgent(database.context, created.id, "agent-two", null);
            const reordered = await requiredProject(projects, database.context, created.id);
            await projects.reorderAgent(database.context, created.id, "agent-two", null);
            expect(await requiredProject(projects, database.context, created.id)).toEqual(
                reordered,
            );

            expect(events.map((event) => event.type)).toEqual([
                "project_created",
                "project_agent_attached",
                "project_agent_attached",
                "project_agent_reordered",
            ]);
            expectProjectUpdateChain(events[1]!, created, attached);
            expectProjectUpdateChain(events[2]!, attached, secondAttached);
            expectProjectUpdateChain(events[3]!, secondAttached, reordered);
            expect(events[3]).toMatchObject({
                association: { agentId: "agent-two", projectId: created.id },
                previousOrderKey: expect.any(String),
            });

            const restarted = projectsModuleFor(config, new GitModule());
            expect(await restarted.get(database.context, created.id)).toEqual(reordered);
            expect(await restarted.listAgentIds(database.context, created.id)).toEqual([
                "agent-two",
                "agent-one",
            ]);
        } finally {
            database.close();
        }
    });

    it("reorders one project without silently changing its neighbours", async () => {
        const database = moduleDatabase(projectMigrations, "project-reorder-event-version-chain");
        await database.ready;
        try {
            const projects = projectsModuleFor(await temporaryTestConfig(), new GitModule());
            const events: ProjectEvent[] = [];
            projects.onEventTransactional((_ctx, event) => {
                events.push(event);
            });

            const first = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/reorder-version-chain-first",
                name: "First",
            });
            const second = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/reorder-version-chain-second",
                name: "Second",
            });
            const third = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/reorder-version-chain-third",
                name: "Third",
            });
            events.length = 0;

            const reordered = await projects.reorder(database.context, {
                afterId: third.id,
                expectedVersion: first.version,
                projectId: first.id,
            });

            expect(await projects.get(database.context, second.id)).toEqual(second);
            expect(await projects.get(database.context, third.id)).toEqual(third);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                type: "project_reordered",
                previousProject: first,
                project: reordered,
            });
            expect(first.orderKey < second.orderKey).toBe(true);
            expect(second.orderKey < third.orderKey).toBe(true);
            expect(third.orderKey < reordered.orderKey).toBe(true);
        } finally {
            database.close();
        }
    });
});

async function requiredProject(
    projects: ProjectsModule,
    ctx: Parameters<ProjectsModule["get"]>[0],
    projectId: string,
) {
    const project = await projects.get(ctx, projectId);
    if (project === undefined) throw new Error("The project disappeared.");
    return project;
}

function expectProjectUpdateChain(
    event: ProjectEvent,
    previousProject: { readonly version: number },
    project: { readonly version: number },
): void {
    expect(event).toHaveProperty("previousProject");
    expect(event).toHaveProperty("project");
    if (!("previousProject" in event) || !("project" in event)) {
        throw new Error("Expected a project lifecycle update event.");
    }
    expect(event.previousProject).toEqual(previousProject);
    expect(event.project).toEqual(project);
    expect(event.previousProject.version).toBe(project.version - 1);
}
