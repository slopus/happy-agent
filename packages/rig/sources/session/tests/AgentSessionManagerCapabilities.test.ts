import { describe, expect, it, vi } from "vitest";

import type { CreateSessionRequest, SessionAgentMetadata } from "../../protocol/index.js";
import { AgentSessionManager } from "../AgentSessionManager.js";
import type { InMemorySession } from "../InMemorySession.js";
import type { HostedCapability } from "@slopus/rig-execution";

function harness(parentRequest: Partial<CreateSessionRequest>) {
    const child = {
        agentMetadata: () => ({
            depth: 1,
            parentSessionId: "root-1",
            rootSessionId: "root-1",
            taskName: "research",
            type: "subagent" as const,
        }),
        id: "child-1",
        isSubagent: () => true,
        subagentSummary: () => ({ status: "running" }),
        submit: vi.fn(() => ({ runId: "child-run" })),
    } as unknown as InMemorySession;
    const parent = {
        agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
        id: "root-1",
        effortLevelsForModel: () => ["low", "medium", "high"],
        hasModel: () => true,
        isSubagent: () => false,
        recordSubagentChanged: vi.fn(),
        requestForSubagent: () => ({
            cwd: "/tmp/rig-capability-test",
            modelId: "xai/grok-4.5",
            permissionMode: "auto",
            providerId: "grok",
            ...parentRequest,
        }),
    } as unknown as InMemorySession;
    const createSubagent = vi.fn(
        (_request: CreateSessionRequest, _metadata: SessionAgentMetadata) => child,
    );
    const manager = new AgentSessionManager({
        repository: {
            createSubagent,
            get: (sessionId) => (sessionId === parent.id ? parent : undefined),
            listByRoot: () => [],
        },
    });
    const spawn = (capabilities: readonly HostedCapability[], modelId = "xai/grok-4.5") =>
        manager.spawn(parent.id, {
            background: true,
            capabilities,
            description: "Research the launch",
            modelId,
            prompt: "What is X saying about the launch?",
            taskName: "research",
        });
    return { createSubagent, spawn };
}

describe("spawning with a hosted capability", () => {
    it("writes the granted capability onto the child", async () => {
        const { createSubagent, spawn } = harness({});
        await spawn(["x_search"]);
        expect(createSubagent.mock.calls[0]?.[0]).toMatchObject({
            hostedCapabilities: ["x_search"],
        });
    });

    it("gives a child that asked for nothing an empty grant rather than the parent's", async () => {
        const { createSubagent, spawn } = harness({ hostedCapabilities: ["x_search"] });
        await spawn([]);
        expect(createSubagent.mock.calls[0]?.[0].hostedCapabilities).toEqual([]);
    });

    it("refuses a grant from a parent that cannot reach outside the sandbox itself", async () => {
        const { createSubagent, spawn } = harness({ permissionMode: "read_only" });
        await expect(spawn(["x_search"])).rejects.toThrow(/cannot grant x_search/u);
        expect(createSubagent).not.toHaveBeenCalled();
    });

    it("refuses a re-grant from a parent that already holds the capability", async () => {
        const { createSubagent, spawn } = harness({ hostedCapabilities: ["x_search"] });
        await expect(spawn(["x_search"])).rejects.toThrow(/holds none itself/u);
        expect(createSubagent).not.toHaveBeenCalled();
    });

    it("refuses a capability the chosen model cannot run", async () => {
        const { createSubagent, spawn } = harness({});
        await expect(spawn(["x_search"], "anthropic/claude-opus-4.6")).rejects.toThrow(
            /Only Grok models execute search on the provider's backend/u,
        );
        expect(createSubagent).not.toHaveBeenCalled();
    });
});
