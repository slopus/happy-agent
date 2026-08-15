import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { grokKillSubagentTool } from "./kill_subagent.js";
import { grokSpawnSubagentTool } from "./spawn_subagent.js";
import { grokFollowupSubagentTool } from "./followup_subagent.js";

describe("grokSpawnSubagentTool", () => {
    it("allows provider selection to be omitted", () => {
        expect(
            Value.Check(grokSpawnSubagentTool.arguments, {
                description: "Inspect code",
                effort: "medium",
                model: "xai/grok-build",
                prompt: "Inspect the implementation.",
            }),
        ).toBe(true);
    });

    it("uses the human-readable task description in the transcript", () => {
        expect(
            grokSpawnSubagentTool.toUI(
                {
                    agent_id: "unguessable-agent-1",
                    path: "/root/fix_the_login_bug",
                    status: "running",
                },
                {
                    background: true,
                    description: "Fix the login bug.",
                    effort: "medium",
                    model: "xai/grok-build",
                    prompt: "Investigate and fix the login bug.",
                    provider: "grok",
                },
            ),
        ).toBe("Started a subagent: Fix the login bug.");
    });

    it("humanizes the generated task name when the description is blank", () => {
        expect(
            grokSpawnSubagentTool.toUI(
                {
                    agent_id: "unguessable-agent-1",
                    path: "/root/delegated_task",
                    status: "running",
                },
                {
                    description: "  ",
                    effort: "medium",
                    model: "xai/grok-build",
                    prompt: "Handle the delegated task.",
                    provider: "grok",
                },
            ),
        ).toBe("Started a subagent: Delegated task.");
    });

    it("forwards the requested model and effort to the managed subagent", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            output: "Complete.",
            path: "/root/inspect_code",
            sessionId: "agent-1",
            status: "completed" as const,
            taskName: "inspect_code",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        const result = await grokSpawnSubagentTool.execute(
            {
                background: false,
                description: "Inspect code",
                effort: "low",
                model: "xai/grok-build",
                prompt: "Inspect the implementation.",
                provider: "grok",
                service_tier: "priority",
                subagent_type: "explore",
            },
            harness.context,
            { ctx: harness.ctx, toolCallId: "tool-1" },
        );

        expect(result).toMatchObject({
            agent_id: "unguessable-agent-1",
            path: "/root/inspect_code",
        });
        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                effort: "low",
                modelId: "xai/grok-build",
                parentToolCallId: "tool-1",
                providerId: "grok",
                readOnly: true,
                serviceTier: "fast",
            }),
            undefined,
        );
    });

    it("reports a failed foreground subagent as a failed tool call", async () => {
        const harness = createJustBashToolHarness();
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn: async () => ({
                agentId: "unguessable-agent-1",
                output: "The subagent ran out of tokens before returning a response.",
                path: "/root/empty_response",
                sessionId: "agent-1",
                status: "error",
                taskName: "empty_response",
            }),
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            grokSpawnSubagentTool.execute(
                {
                    background: false,
                    description: "Return nothing",
                    effort: "medium",
                    model: "xai/grok-build",
                    prompt: "Finish without returning text.",
                    provider: "grok",
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("ran out of tokens before returning a response");
    });

    it("forwards parent context messages to the managed subagent", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            output: "Complete.",
            path: "/root/inspect_code",
            sessionId: "agent-1",
            status: "completed" as const,
            taskName: "inspect_code",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };
        const parentMessage = {
            blocks: [{ text: "Inspect the implementation.", type: "text" as const }],
            id: "parent-user",
            role: "user" as const,
        };
        const currentAgentMessage = {
            blocks: [],
            id: "parent-agent",
            role: "agent" as const,
        };

        await grokSpawnSubagentTool.execute(
            {
                background: false,
                context: "parent",
                description: "Inspect code",
                effort: "low",
                model: "xai/grok-build",
                prompt: "Inspect the implementation.",
                provider: "grok",
            },
            harness.context,
            { ctx: harness.ctx, messages: [parentMessage, currentAgentMessage] },
        );

        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                contextMessages: [parentMessage],
                contextMode: "parent",
            }),
            undefined,
        );
    });

    it("propagates a database failure while stopping a subagent", async () => {
        const harness = createJustBashToolHarness();
        const databaseError = new Error("database write failed") as Error & { code: string };
        databaseError.code = "SQLITE_IOERR";
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(() => {
                throw databaseError;
            }),
            list: () => [],
            maxDepth: 3,
            spawn: vi.fn(),
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            grokKillSubagentTool.execute({ target: "unguessable-agent-1" }, harness.context, {
                ctx: harness.ctx,
            }),
        ).rejects.toBe(databaseError);
    });

    it("returns an Agent ID and canonical path when stopping a subagent", async () => {
        const harness = createJustBashToolHarness();
        const interrupt = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            description: "Inspect code",
            path: "/root/inspect_code",
            sessionId: "agent-1",
            status: "running" as const,
            taskName: "inspect_code",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt,
            list: () => [],
            maxDepth: 3,
            spawn: vi.fn(),
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            grokKillSubagentTool.execute({ target: "unguessable-agent-1" }, harness.context, {
                ctx: harness.ctx,
            }),
        ).resolves.toMatchObject({
            agent_id: "unguessable-agent-1",
            path: "/root/inspect_code",
        });
        expect(interrupt).toHaveBeenCalledWith("unguessable-agent-1");
    });

    it("follows up a retained subagent at the requested effort", async () => {
        const harness = createJustBashToolHarness();
        const followUp = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            description: "Inspect code",
            path: "/root/inspect_code",
            sessionId: "agent-1",
            status: "running" as const,
            taskName: "inspect_code",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp,
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn: vi.fn(),
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            grokFollowupSubagentTool.execute(
                {
                    effort: "high",
                    prompt: "Inspect the final diff.",
                    target: "unguessable-agent-1",
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).resolves.toMatchObject({
            agent_id: "unguessable-agent-1",
            path: "/root/inspect_code",
        });
        expect(followUp).toHaveBeenCalledWith(
            "unguessable-agent-1",
            "Inspect the final diff.",
            "high",
        );
    });
});
