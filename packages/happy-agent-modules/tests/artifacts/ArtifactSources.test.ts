import { afterEach, describe, expect, it } from "vitest";

import { ArtifactInputError } from "../../sources/artifacts/index.js";
import { artifactsWorld, type ArtifactsWorld } from "./support/artifactsWorld.js";

const worlds: ArtifactsWorld[] = [];
afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
});

async function world(name: string, workspaces = false): Promise<ArtifactsWorld> {
    const created = await artifactsWorld(name, { workspaces });
    worlds.push(created);
    return created;
}

describe("where an agent's artifacts are recorded as made", () => {
    it("names the bot an agent works for, even several conversations down", async () => {
        const w = await world("artifact-sources-bot");
        w.agents.add("agentbot");
        w.agents.add("agentchild", "agentbot");
        w.agents.add("agentgrandchild", "agentchild");
        w.places.botAgents.set("agentbot", "botone");

        await expect(w.artifacts.actorFor(w.ctx, "agentbot")).resolves.toEqual({
            author: { kind: "agent", agentId: "agentbot", botId: "botone" },
            source: { kind: "bot", botId: "botone", agentId: "agentbot" },
        });
        // The place is the bot's; the conversation and the author stay the acting agent.
        await expect(w.artifacts.actorFor(w.ctx, "agentgrandchild")).resolves.toEqual({
            author: { kind: "agent", agentId: "agentgrandchild", botId: "botone" },
            source: { kind: "bot", botId: "botone", agentId: "agentgrandchild" },
        });
    });

    it("names a task, a workspace, or a project root, whichever the nearest agent belongs to", async () => {
        const w = await world("artifact-sources-places", true);
        w.agents.add("agenttask");
        w.agents.add("agentworkspace");
        w.agents.add("agentunder", "agentworkspace");
        w.agents.add("agentroot");
        w.places.taskAgents.set("agenttask", "taskone");
        w.places.workspaceAgents.set("agentworkspace", "workspaceone");
        w.places.workspaces.set("workspaceone", "projectone");
        // A project's root workspace has the project's own ID.
        w.places.projects.add("projectone");
        w.places.workspaceAgents.set("agentroot", "projectone");
        w.places.workspaces.set("projectone", "projectone");

        await expect(w.artifacts.actorFor(w.ctx, "agenttask")).resolves.toEqual({
            author: { kind: "agent", agentId: "agenttask" },
            source: { kind: "task", taskId: "taskone", agentId: "agenttask" },
        });
        await expect(w.artifacts.actorFor(w.ctx, "agentunder")).resolves.toEqual({
            author: { kind: "agent", agentId: "agentunder" },
            source: {
                kind: "workspace",
                workspaceId: "workspaceone",
                projectId: "projectone",
                agentId: "agentunder",
            },
        });
        await expect(w.artifacts.actorFor(w.ctx, "agentroot")).resolves.toEqual({
            author: { kind: "agent", agentId: "agentroot" },
            source: { kind: "project", projectId: "projectone", agentId: "agentroot" },
        });
    });

    it("falls back to a project's own agents without workspaces, and then to the conversation", async () => {
        const w = await world("artifact-sources-fallback");
        w.agents.add("agentproject");
        w.agents.add("agentalone");
        w.places.projectAgents.set("agentproject", "projecttwo");

        await expect(w.artifacts.actorFor(w.ctx, "agentproject")).resolves.toMatchObject({
            source: { kind: "project", projectId: "projecttwo", agentId: "agentproject" },
        });
        await expect(w.artifacts.actorFor(w.ctx, "agentalone")).resolves.toEqual({
            author: { kind: "agent", agentId: "agentalone" },
            source: { kind: "agent", agentId: "agentalone" },
        });
    });

    it("checks a source a person names, filling a workspace's project", async () => {
        const w = await world("artifact-sources-named", true);
        w.agents.add("agentknown");
        w.places.botAgents.set("agentknown", "botknown");
        w.places.workspaces.set("workspaceone", "projectone");

        await expect(
            w.artifacts.resolveSource(w.ctx, { kind: "workspace", workspaceId: "workspaceone" }),
        ).resolves.toEqual({
            kind: "workspace",
            workspaceId: "workspaceone",
            projectId: "projectone",
        });
        await expect(
            w.artifacts.resolveSource(w.ctx, { kind: "bot", botId: "botknown" }),
        ).resolves.toEqual({ kind: "bot", botId: "botknown" });
        for (const source of [
            { kind: "bot" as const, botId: "botmissing" },
            { kind: "task" as const, taskId: "taskmissing" },
            { kind: "project" as const, projectId: "projectmissing" },
            { kind: "workspace" as const, workspaceId: "workspacemissing" },
            { kind: "workspace" as const, workspaceId: "workspaceone", projectId: "projectother" },
            { kind: "agent" as const, agentId: "agentmissing" },
        ]) {
            await expect(w.artifacts.resolveSource(w.ctx, source)).rejects.toBeInstanceOf(
                ArtifactInputError,
            );
        }
    });
});
