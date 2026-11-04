import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

let happyHome: string;
let runtime: HappyAgentRuntime | undefined;

beforeEach(async () => {
    happyHome = await mkdtemp(join(tmpdir(), "happy-collaborator-archival-"));
});

afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await rm(happyHome, { force: true, recursive: true });
});

describe("collaborator archival in the runtime", () => {
    /**
     * Archival writes `archivedAt`, which the API answers by refreshing the agent's owner
     * visibility. A hidden collaborator has no bot, task, chat, workspace, or project owning it,
     * so that refresh threw "The agent owner was not found." and rolled the archival back.
     */
    it("archives a hidden collaborator that no owner series holds", async () => {
        const providers = new AgentProviders();
        providers.add("gym", new ScriptedProvider([]), "codex");
        runtime = await startHappyAgentRuntime({
            happyHome,
            inference: {
                providers,
                models: [
                    {
                        id: "gym/model",
                        providerId: "gym",
                        name: "Gym",
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                    },
                ],
            },
        });
        const ctx = withAgentDatabase(
            runtime.ctx.named("test.collaborator-archival"),
            runtime.database,
        );
        const task = await runtime.modules.tasks.create(ctx, { name: "Coordinator" });
        const collaborator = await runtime.system.create(
            ctx,
            { metadata: { title: "Helper" } },
            { parent: task.agentId },
        );

        await ctx.inTx(async (txCtx) => {
            await runtime!.modules.collaboration.archiveAgent(txCtx, task.agentId, collaborator.id);
        });

        const config = await runtime.system.config(ctx, collaborator.id);
        expect(config?.metadata?.["archivedAt"]).toEqual(expect.any(Number));
        expect(await runtime.system.parentOf(ctx, collaborator.id)).toBe(task.agentId);
    }, 60_000);
});
