import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";

import { claudeAgentTool } from "../tools/claude/Agent.js";
import { codexExtendedSpawnAgentTool } from "../tools/codex/v2/collaboration_ext/spawn_agent.js";
import { createJustBashToolHarness } from "../../tools/testing/createJustBashToolHarness.js";
import { grokSpawnSubagentTool } from "../../tools/grok/spawn_subagent.js";
import {
    createSpawnCapabilityGrantDescriber,
    spawnGrantsCapabilities,
    subagentCapabilitiesArgumentSchema,
} from "./subagentCapabilityDescriptions.js";

const spawnTools = [
    ["Agent", claudeAgentTool],
    ["spawn_subagent", grokSpawnSubagentTool],
    ["collaboration_ext.spawn_agent", codexExtendedSpawnAgentTool],
] as const;

describe("the capability argument", () => {
    it("accepts a known capability and rejects anything else", () => {
        const schema = Type.Object({ capabilities: subagentCapabilitiesArgumentSchema });
        expect(Value.Check(schema, { capabilities: ["x_search"] })).toBe(true);
        expect(Value.Check(schema, { capabilities: ["web_search", "x_search"] })).toBe(true);
        expect(Value.Check(schema, {})).toBe(true);
        expect(Value.Check(schema, { capabilities: ["read_email"] })).toBe(false);
    });

    it.each(spawnTools)("is offered by %s", (_name, tool) => {
        expect(Object.keys(tool.arguments.properties)).toContain("capabilities");
    });
});

describe("the review policy", () => {
    it("leaves an ordinary spawn unreviewed", () => {
        expect(spawnGrantsCapabilities({})).toBe(false);
        expect(spawnGrantsCapabilities({ capabilities: [] })).toBe(false);
    });

    it("reviews a spawn that grants a capability", () => {
        expect(spawnGrantsCapabilities({ capabilities: ["x_search"] })).toBe(true);
    });

    it.each(spawnTools)("applies both rules on %s", async (_name, tool) => {
        const harness = createJustBashToolHarness();
        expect(
            await tool.shouldReviewInAutoMode({ capabilities: [] } as never, harness.context),
        ).toBe(false);
        expect(
            await tool.shouldReviewInAutoMode(
                { capabilities: ["x_search"] } as never,
                harness.context,
            ),
        ).toBe(true);
    });

    it("tells the reviewer what the grant reaches and that it is the only approval", () => {
        const harness = createJustBashToolHarness();
        const described = createSpawnCapabilityGrantDescriber({
            inheritsConversationByDefault: false,
        })(
            { capabilities: ["x_search"], description: "Find reactions to the launch" },
            harness.context,
        );
        expect(described).toContain("search X (Twitter) on the provider's backend");
        expect(described).toContain("Rig cannot review those searches individually");
        expect(described).toContain("Find reactions to the launch");
        expect(described).toContain("network access outside Rig's shell sandbox");
    });

    it("never tells the reviewer the conversation is out of the child's reach", () => {
        const harness = createJustBashToolHarness();
        const taskFirst = createSpawnCapabilityGrantDescriber({
            inheritsConversationByDefault: false,
        });
        const conversationFirst = createSpawnCapabilityGrantDescriber({
            inheritsConversationByDefault: true,
        });
        // Whatever the dialect and whatever the arguments, the sentence about this conversation
        // reaching the search is there. A spawned child holds `read_agent_history`, which walks to
        // the root of its own tree without asking, so a review that promised isolation on the
        // task-only path would be promising something no argument to this tool controls.
        for (const described of [
            taskFirst({ capabilities: ["x_search"] }, harness.context),
            taskFirst({ capabilities: ["x_search"], context: "parent" }, harness.context),
            conversationFirst({ capabilities: ["x_search"] }, harness.context),
            conversationFirst({ capabilities: ["x_search"], fork_turns: "none" }, harness.context),
        ]) {
            expect(described).toContain("anything in it can reach the search");
        }
    });

    it("separates the conversation the child is handed from the one it would have to go get", () => {
        const harness = createJustBashToolHarness();
        const taskFirst = createSpawnCapabilityGrantDescriber({
            inheritsConversationByDefault: false,
        });
        const conversationFirst = createSpawnCapabilityGrantDescriber({
            inheritsConversationByDefault: true,
        });
        expect(taskFirst({ capabilities: ["x_search"] }, harness.context)).toContain(
            "can read this conversation",
        );
        expect(
            taskFirst({ capabilities: ["x_search"], context: "parent" }, harness.context),
        ).toContain("starts with this conversation");
        // Codex forks unless told not to, so saying nothing is the request that hands it over.
        expect(conversationFirst({ capabilities: ["x_search"] }, harness.context)).toContain(
            "starts with this conversation",
        );
        expect(
            conversationFirst({ capabilities: ["x_search"], fork_turns: "none" }, harness.context),
        ).toContain("can read this conversation");
    });
});

describe("a spawn tool given capabilities", () => {
    it("passes them to the subagent context", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn().mockResolvedValue({
            output: "",
            path: "/root/research",
            sessionId: "agent-1",
            status: "running",
            taskName: "research",
        });
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: () => {
                throw new Error("unused");
            },
            interrupt: () => {
                throw new Error("unused");
            },
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await claudeAgentTool.execute(
            {
                capabilities: ["x_search"],
                description: "Research the launch",
                effort: "medium",
                model: "xai/grok-4.5",
                prompt: "What is X saying about the launch?",
            },
            harness.context,
            { signal: new AbortController().signal },
        );

        expect(spawn.mock.calls[0]?.[0]).toMatchObject({ capabilities: ["x_search"] });
    });

    it("omits the key entirely when no capability was asked for", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn().mockResolvedValue({
            output: "",
            path: "/root/plain",
            sessionId: "agent-2",
            status: "running",
            taskName: "plain",
        });
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: () => {
                throw new Error("unused");
            },
            interrupt: () => {
                throw new Error("unused");
            },
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await claudeAgentTool.execute(
            {
                capabilities: [],
                description: "Ordinary work",
                effort: "medium",
                model: "xai/grok-4.5",
                prompt: "Do the ordinary work.",
            },
            harness.context,
            { signal: new AbortController().signal },
        );

        expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("capabilities");
    });
});
