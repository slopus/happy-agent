import { describe, expect, it, vi } from "vitest";

import type {
    CreateSessionRequest,
    ProjectWorkspace,
    SessionAgentMetadata,
} from "../../protocol/index.js";
import { AgentSessionManager } from "../AgentSessionManager.js";
import type { InMemorySession } from "../InMemorySession.js";
import {
    subagentMaxDepthFromEnvironment,
    subagentModelPolicyFromEnvironment,
    type SubagentModelPolicy,
} from "../subagentModelPolicy.js";

describe("AgentSessionManager", () => {
    it("sends agent-authored steering and changes an owned delegate permission mode", async () => {
        const deliverAgentMessage = vi.fn();
        const changePermissionMode = vi.fn(async () => ({ permissionMode: "read_only" }));
        const senderLocation = vi.fn<
            () => ReturnType<InMemorySession["agentCommunicationLocation"]>
        >(() => ({
            cwd: "/workspaces/sender",
            sessionId: "sender-session",
        }));
        const targetLocation = vi.fn<
            () => ReturnType<InMemorySession["agentCommunicationLocation"]>
        >(() => ({
            cwd: "/workspaces/target",
            sessionId: "target-session",
        }));
        const targetMetadata = vi.fn<() => SessionAgentMetadata>(() => ({
            delegatedBySessionId: "sender-session",
            depth: 0,
            rootSessionId: "target-session",
            type: "primary" as const,
        }));
        const sender = {
            agentCommunicationLocation: senderLocation,
            agentIdentity: () => ({
                agentId: "sender-agent-id",
                folder: "sender",
                title: "Fix authentication",
            }),
            agentMetadata: () => ({
                depth: 0,
                rootSessionId: "sender-session",
                type: "primary" as const,
            }),
            id: "sender-session",
            requestForSubagent: () => ({ permissionMode: "auto" }),
        } as unknown as InMemorySession;
        const target = {
            agentCommunicationLocation: targetLocation,
            agentIdentity: () => ({
                agentId: "target-agent-id",
                folder: "target",
                title: "Review authentication",
            }),
            agentMetadata: targetMetadata,
            changePermissionMode,
            deliverAgentMessage,
            id: "target-session",
        } as unknown as InMemorySession;
        const intermediate = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "sender-session",
                rootSessionId: "sender-session",
                taskName: "intermediate",
                type: "subagent" as const,
            }),
            id: "intermediate-session",
        } as unknown as InMemorySession;
        const findByAgentId = vi.fn((agentId: string) =>
            agentId === "target-agent-id" ? target : undefined,
        );
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                findByAgentId,
                get: (id) =>
                    id === sender.id
                        ? sender
                        : id === target.id
                          ? target
                          : id === intermediate.id
                            ? intermediate
                            : undefined,
                listByRoot: () => [intermediate, target],
            },
        });
        const communication = manager.communicationContext(sender.id);

        expect(communication.me()).toEqual({
            agentId: "sender-agent-id",
            folder: "sender",
            title: "Fix authentication",
        });
        expect(() => communication.send("target-agent-id", "Please check my patch.")).toThrow(
            "Call agent_info with this agent ID before sending it a message.",
        );
        expect(communication.info("target-agent-id")).toEqual({
            agentId: "target-agent-id",
            diskShared: true,
            folder: "target",
            path: "/workspaces/target",
            title: "Review authentication",
        });
        expect(communication.send("target-agent-id", "Please check my patch.")).toEqual({
            delivered: true,
        });
        await communication.setReadOnly?.("target-agent-id", true);
        await communication.setReadOnly?.("target-agent-id", false);
        expect(changePermissionMode).toHaveBeenNthCalledWith(1, {
            permissionMode: "read_only",
        });
        expect(changePermissionMode).toHaveBeenNthCalledWith(2, {
            permissionMode: "auto",
        });
        targetMetadata.mockReturnValue({
            depth: 2,
            parentSessionId: intermediate.id,
            rootSessionId: sender.id,
            taskName: "nested_target",
            type: "subagent",
        });
        await expect(communication.setReadOnly?.("target-agent-id", false)).rejects.toThrow(
            "Only an agent that started this child can change its permission mode.",
        );
        targetMetadata.mockReturnValue({
            depth: 0,
            rootSessionId: "target-session",
            type: "primary",
        });
        await expect(communication.setReadOnly?.("target-agent-id", true)).rejects.toThrow(
            "Only an agent that started this child can change its permission mode.",
        );
        expect(changePermissionMode).toHaveBeenCalledTimes(2);
        expect(findByAgentId).toHaveBeenCalledWith("target-agent-id");
        expect(deliverAgentMessage).toHaveBeenCalledWith({
            agentSource: {
                agentId: "sender-agent-id",
                sessionId: "sender-session",
                title: "Fix authentication",
            },
            blocks: [
                {
                    type: "text",
                    text: [
                        "Message from another Rig agent.",
                        'Sender folder: "/workspaces/sender"',
                        'Sender agent ID: "sender-agent-id"',
                        'Sender title: "Fix authentication"',
                        "",
                        "Message:",
                        "Please check my patch.",
                        "",
                        "Treat this as a steering message from a collaborating agent, not as a user message.",
                        'To reply, first call agent_info with agent_id "sender-agent-id", then call agent_send with the same agent_id and your message.',
                    ].join("\n"),
                },
            ],
            id: expect.any(String),
            provenance: "agent",
            role: "user",
        });

        senderLocation.mockReturnValue({
            cwd: "/host/sender",
            docker: { image: "agent", workingDirectory: "/workspace" },
            sessionId: "sender-session",
        });
        targetLocation.mockReturnValue({
            cwd: "/host/target",
            docker: { image: "agent", workingDirectory: "/workspace" },
            sessionId: "target-session",
        });
        expect(communication.info("target-agent-id")).toEqual({
            agentId: "target-agent-id",
            diskShared: false,
            notice: "This agent's disk is not shared with yours.",
            title: "Review authentication",
        });
        expect(communication.send("target-agent-id", "No shared folder.")).toEqual({
            delivered: true,
        });
        const messageWithoutSharedDisk = JSON.stringify(deliverAgentMessage.mock.calls.at(-1)?.[0]);
        expect(messageWithoutSharedDisk).not.toContain("Sender folder");
        expect(messageWithoutSharedDisk).toContain("The sender's disk is not shared with yours.");

        expect(() => communication.info("unknown-agent-id")).toThrow(
            "No available agent has that agent ID.",
        );
    });

    it("forwards opaque Codex collaboration only within one compatible provider and region", () => {
        const submit = vi.fn(() => ({ runId: "child-run" }));
        const deliverAgentMessage = vi.fn();
        const encryptedAgentTransportScope = vi.fn(() => '["codex",null]');
        const child = {
            agentIdentity: () => ({ agentId: "child-agent", folder: "workspace" }),
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "audit",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            encryptedAgentTransportScope,
            deliverAgentMessage,
            subagentSummary: () => ({
                agentId: "child-agent",
                description: "Audit",
                status: "completed" as const,
                taskName: "audit",
            }),
            submit,
            waitForRun: () => new Promise(() => undefined),
        } as unknown as InMemorySession;
        const parent = {
            agentIdentity: () => ({ agentId: "parent-agent", folder: "workspace" }),
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            encryptedAgentTransportScope: () => '["codex",null]',
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (id) => (id === parent.id ? parent : id === child.id ? child : undefined),
                listByRoot: () => [child],
            },
        });

        expect(
            manager.followUp(parent.id, "/root/audit", "", undefined, "opaque-task"),
        ).toMatchObject({
            agentId: "child-agent",
        });
        expect(submit).toHaveBeenCalledWith({
            agentMessageTriggerTurn: true,
            displayText: "Follow-up task",
            encryptedAgentMessage: {
                author: "/root",
                recipient: "/root/audit",
                header: "Message Type: NEW_TASK\nRecipient Agent ID: child-agent\nRecipient path: /root/audit\nSender Agent ID: parent-agent\nSender path: /root\nPayload:\n",
                encryptedContent: "opaque-task",
            },
            provenance: "agent",
            text: "",
        });

        expect(manager.sendMessage(parent.id, "/root/audit", "", "opaque-message")).toMatchObject({
            agentId: "child-agent",
        });
        expect(deliverAgentMessage).toHaveBeenCalledWith({
            blocks: [],
            encryptedAgentMessage: {
                author: "/root",
                recipient: "/root/audit",
                header: "Message Type: MESSAGE\nRecipient Agent ID: child-agent\nRecipient path: /root/audit\nSender Agent ID: parent-agent\nSender path: /root\nPayload:\n",
                encryptedContent: "opaque-message",
            },
            id: expect.any(String),
            provenance: "agent",
            role: "user",
        });

        encryptedAgentTransportScope.mockReturnValue('["bedrock","us-east-1"]');
        expect(() =>
            manager.followUp(parent.id, "/root/audit", "", undefined, "opaque-task"),
        ).toThrow(
            "Native encrypted collaboration only works within the same compatible provider and region. Retry with `rig.followup_task` and provide the task normally.",
        );
        expect(() => manager.sendMessage(parent.id, "/root/audit", "", "opaque-message")).toThrow(
            "Native encrypted collaboration only works within the same compatible provider and region.",
        );
        expect(submit).toHaveBeenCalledOnce();

        expect(
            manager.followUp(parent.id, "/root/audit", "Plain cross-provider task"),
        ).toMatchObject({ agentId: "child-agent" });
        expect(submit).toHaveBeenLastCalledWith({
            agentMessageTriggerTurn: true,
            provenance: "agent",
            text: "Plain cross-provider task",
        });
    });

    it("enforces the shared child limit before starting an idle follow-up", () => {
        const idle = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "idle",
                type: "subagent" as const,
            }),
            id: "idle",
            isSubagent: () => true,
            subagentSummary: () => ({
                description: "Idle",
                status: "completed" as const,
                taskName: "idle",
            }),
        } as unknown as InMemorySession;
        const running = Array.from({ length: 3 }, (_, index) => ({
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: `running_${index}`,
                type: "subagent" as const,
            }),
            id: `running-${index}`,
            isSubagent: () => true,
            subagentSummary: () => ({
                description: "Running",
                status: "running" as const,
                taskName: `running_${index}`,
            }),
        })) as unknown as InMemorySession[];
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            encryptedAgentTransportScope: () => '["codex",null]',
            id: "root-1",
            isCodexV2Collaboration: () => true,
            isSubagent: () => false,
        } as unknown as InMemorySession;
        const sessions = [idle, ...running];
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (id) =>
                    id === root.id ? root : sessions.find((session) => session.id === id),
                listByRoot: () => sessions,
            },
        });

        expect(() => manager.followUp(root.id, "/root/idle", "Continue.")).toThrow(
            "No more than 3 subagents can run at once.",
        );
    });

    it("keeps the existing generic limit and narrows Codex V2 trees", () => {
        const codexRoot = {
            encryptedAgentTransportScope: () => '["codex",null]',
            id: "codex-root",
            isCodexV2Collaboration: () => true,
        } as unknown as InMemorySession;
        const bedrockRoot = {
            id: "bedrock-root",
            isCodexV2Collaboration: () => false,
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: () => {
                    throw new Error("Not used by this test.");
                },
                get: (sessionId) =>
                    sessionId === codexRoot.id
                        ? codexRoot
                        : sessionId === bedrockRoot.id
                          ? bedrockRoot
                          : undefined,
                listByRoot: () => [],
            },
        });

        expect(manager.maxActive).toBe(8);
        expect(manager.maxActiveFor("generic-root")).toBe(8);
        expect(manager.maxActiveFor(codexRoot.id)).toBe(3);
        expect(manager.maxActiveFor(bedrockRoot.id)).toBe(8);
    });

    it("reads paginated history from the root and nested subagents by task path", () => {
        const root = historySession({
            id: "root-1",
            messages: ["root-one", "root-two"],
            metadata: { depth: 0, rootSessionId: "root-1", type: "primary" },
        });
        const child = historySession({
            id: "child-1",
            messages: ["child-one", "child-two", "child-three"],
            metadata: {
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "audit",
                type: "subagent",
            },
        });
        const nested = historySession({
            id: "nested-1",
            messages: ["nested-one"],
            metadata: {
                depth: 2,
                parentSessionId: "child-1",
                rootSessionId: "root-1",
                taskName: "details",
                type: "subagent",
            },
        });
        const sessions = new Map([root, child, nested].map((session) => [session.id, session]));
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => [child, nested],
            },
        });

        const page = manager.readChatHistory(root.id, {
            cursor: 1,
            limit: 1,
            target: "agent-child-1",
        });

        expect(page).toMatchObject({
            agent: { agentId: "agent-child-1", path: "/root/audit" },
            agents: [
                { agentId: "agent-root-1", messageCount: 2, path: "/root" },
                {
                    agentId: "agent-child-1",
                    messageCount: 3,
                    path: "/root/audit",
                },
                {
                    agentId: "agent-nested-1",
                    messageCount: 1,
                    path: "/root/audit/details",
                },
            ],
            cursor: 1,
            nextCursor: 2,
            previousCursor: 0,
            matchedMessages: 3,
            totalMessages: 3,
        });
        expect(page.messages[0]).toMatchObject({
            message: { blocks: [{ text: "child-two", type: "text" }] },
            position: 1,
        });
        expect(() =>
            manager.readChatHistory(root.id, {
                limit: 1,
                target: child.id,
            }),
        ).toThrow("was not found");
        expect(() =>
            manager.readChatHistory(root.id, {
                limit: 1,
                target: "audit",
            }),
        ).toThrow("was not found");
        expect(() =>
            manager.readChatHistory(root.id, {
                limit: 1,
                target: "current",
            }),
        ).toThrow("was not found");
    });

    it("filters full stored content and navigates filtered matches from either end", () => {
        const root = historyMessageSession({
            id: "root-1",
            messages: [
                { blocks: [{ text: "Boot", type: "text" }], id: "system", role: "system" },
                { blocks: [{ text: "First user", type: "text" }], id: "user-1", role: "user" },
                {
                    blocks: [
                        { thinking: "Authentication hypothesis", type: "thinking" },
                        { text: "Assistant answer", type: "text" },
                    ],
                    id: "assistant",
                    role: "agent",
                },
                {
                    blocks: [
                        {
                            arguments: { route: "secret-route" },
                            id: "call",
                            name: "inspect",
                            type: "tool_call",
                        },
                    ],
                    id: "tool-call",
                    role: "agent",
                },
                {
                    blocks: [
                        {
                            display: "Inspected route",
                            rendered: [{ text: "Stored full tool output", type: "text" }],
                            toolCallId: "call",
                            toolName: "inspect",
                            type: "tool_result",
                        },
                    ],
                    id: "tool-result",
                    role: "agent",
                },
                { blocks: [{ text: "Last user", type: "text" }], id: "user-2", role: "user" },
            ],
            metadata: { depth: 0, rootSessionId: "root-1", type: "primary" },
        });
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: () => root,
                listByRoot: () => [],
            },
        });

        const finalUser = manager.readChatHistory(root.id, {
            from: "end",
            limit: 1,
            roles: ["user"],
        });
        expect(finalUser).toMatchObject({
            cursor: 5,
            matchedMessages: 2,
            previousCursor: 1,
            totalMessages: 6,
        });
        expect(finalUser.messages.map((entry) => entry.position)).toEqual([5]);
        expect(finalUser.matchedStats).toMatchObject({ messages: 2, userMessages: 2 });
        expect(finalUser.totalStats).toMatchObject({ messages: 6, userMessages: 2 });
        if (finalUser.previousCursor === undefined) {
            throw new Error("Expected a cursor for the preceding filtered page.");
        }

        const firstUser = manager.readChatHistory(root.id, {
            cursor: finalUser.previousCursor,
            limit: 1,
            roles: ["user"],
        });
        expect(firstUser.messages.map((entry) => entry.position)).toEqual([1]);
        expect(firstUser.nextCursor).toBe(5);

        const thinkingMatch = manager.readChatHistory(root.id, {
            from: "start",
            limit: 10,
            query: "authentication",
            roles: ["assistant"],
        });
        expect(thinkingMatch.messages.map((entry) => entry.position)).toEqual([2]);

        const toolArgumentMatch = manager.readChatHistory(root.id, {
            from: "start",
            limit: 10,
            query: "secret-route",
        });
        expect(toolArgumentMatch.messages.map((entry) => entry.position)).toEqual([3]);
    });

    it("uses a requested model for a workflow child while inheriting the remaining session settings", async () => {
        const child = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "model_check",
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
            effortLevelsForModel: (modelId: string, providerId: string) =>
                modelId === "anthropic/claude-opus-4.6" && providerId === "claude"
                    ? ["off", "low", "medium", "high"]
                    : undefined,
            hasModel: (modelId: string, providerId?: string) =>
                modelId === "anthropic/claude-opus-4.6" && providerId === "claude",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                instructions: "Inherited instructions",
                modelId: "openai/gpt-5.5",
                permissionMode: "auto",
                providerId: "codex",
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

        await manager.spawn(parent.id, {
            background: true,
            description: "Check another model",
            effort: "high",
            modelId: "anthropic/claude-opus-4.6",
            providerId: "claude",
            prompt: "Inspect with the requested model.",
            taskName: "model_check",
        });

        expect(createSubagent).toHaveBeenCalledWith(
            expect.objectContaining({
                cwd: "/tmp/rig-manager-test",
                effort: "high",
                instructions: expect.stringContaining("Inherited instructions"),
                modelId: "anthropic/claude-opus-4.6",
                permissionMode: "auto",
                providerId: "claude",
            }),
            expect.objectContaining({ taskName: "model_check" }),
        );
        const childInstructions = createSubagent.mock.calls[0]?.[0].instructions;
        expect(childInstructions).toContain("You are a child subagent");
        expect(childInstructions).toContain("You are not the parent agent");
        expect(childInstructions).toContain(
            "Do not spawn another subagent unless the parent explicitly instructed you",
        );
        expect(child.submit).toHaveBeenCalledWith({
            agentMessageTriggerTurn: true,
            provenance: "agent",
            text: "Inspect with the requested model.",
        });
        await expect(
            manager.spawn(parent.id, {
                description: "Unknown model",
                modelId: "missing/model",
                providerId: "claude",
                prompt: "This should not start.",
            }),
        ).rejects.toThrow("Model 'missing/model' is not available for provider 'claude'.");
        expect(createSubagent).toHaveBeenCalledOnce();

        await expect(
            manager.spawn(parent.id, {
                description: "Unsupported effort",
                effort: "ultra",
                modelId: "anthropic/claude-opus-4.6",
                providerId: "claude",
                prompt: "This should not start.",
            }),
        ).rejects.toThrow(
            "Model 'anthropic/claude-opus-4.6' does not support 'ultra' effort. Allowed effort levels: off, low, medium, high.",
        );
        expect(createSubagent).toHaveBeenCalledOnce();
    });

    it("can start a single subagent read only without changing the parent mode", async () => {
        const child = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "inspect_only",
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
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
            }),
        } as unknown as InMemorySession;
        const createSubagent = vi.fn(() => child);
        const manager = new AgentSessionManager({
            repository: {
                createSubagent,
                get: (sessionId) => (sessionId === parent.id ? parent : undefined),
                listByRoot: () => [],
            },
        });

        await manager.spawn(parent.id, {
            background: true,
            description: "Inspect only",
            prompt: "Inspect without editing.",
            readOnly: true,
            taskName: "inspect_only",
        });

        expect(createSubagent).toHaveBeenCalledWith(
            expect.objectContaining({ permissionMode: "read_only" }),
            expect.objectContaining({ taskName: "inspect_only" }),
        );
        expect(parent.requestForSubagent().permissionMode).toBe("auto");
    });

    it("rejects encrypted spawn delivery across provider or region scopes", async () => {
        const parentTransportScope = vi.fn<() => string | undefined>(() => '["codex",null]');
        const child = {
            id: "child-1",
            submit: vi.fn(),
        } as unknown as InMemorySession;
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            encryptedAgentTransportScope: parentTransportScope,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
            }),
        } as unknown as InMemorySession;
        const createSubagent = vi.fn(() => child);
        const manager = new AgentSessionManager({
            repository: {
                createSubagent,
                get: (sessionId) => (sessionId === parent.id ? parent : undefined),
                listByRoot: () => [],
            },
        });

        await expect(
            manager.spawn(parent.id, {
                encryptedPrompt: "opaque-cloud-ciphertext",
                description: "Unsafe crossing",
                modelId: "openai/gpt-5.6-sol",
                prompt: "",
                providerId: "bedrock",
                taskName: "unsafe_crossing",
            }),
        ).rejects.toThrow(
            "Native encrypted collaboration only works within the current compatible provider and region. Use `rig.spawn_agent` and provide the task normally when selecting or crossing a model, provider, or region.",
        );
        expect(createSubagent).not.toHaveBeenCalled();
        expect(child.submit).not.toHaveBeenCalled();

        await expect(
            manager.spawn(parent.id, {
                encryptedPrompt: "opaque-luna-ciphertext",
                description: "Unsupported V1 model",
                modelId: "openai/gpt-5.6-luna",
                prompt: "",
                taskName: "unsupported_luna",
            }),
        ).rejects.toThrow("Native encrypted collaboration only works within the current");
        expect(createSubagent).not.toHaveBeenCalled();

        parentTransportScope.mockReturnValue(undefined);
        await expect(
            manager.spawn(parent.id, {
                encryptedPrompt: "opaque-without-native-scope",
                description: "Missing native scope",
                prompt: "",
                taskName: "missing_scope",
            }),
        ).rejects.toThrow("Native encrypted collaboration only works within the current");
        expect(createSubagent).not.toHaveBeenCalled();
    });

    it("infers a provider for model-only requests and reuses the last successful provider", async () => {
        const providerModels = new Map([
            ["codex", new Set(["shared/current"])],
            ["claude", new Set(["shared/current", "claude/unique", "shared/ambiguous"])],
            ["grok", new Set(["shared/ambiguous"])],
        ]);
        const child = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "model_check",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            subagentSummary: () => ({ status: "running" }),
            submit: vi.fn(() => ({ runId: "child-run" })),
        } as unknown as InMemorySession;
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            hasModel: (modelId: string, providerId?: string) =>
                providerId === undefined
                    ? [...providerModels.values()].some((models) => models.has(modelId))
                    : (providerModels.get(providerId)?.has(modelId) ?? false),
            id: "root-1",
            isSubagent: () => false,
            modelIdsForProvider: (providerId: string) => [
                ...(providerModels.get(providerId) ?? []),
            ],
            providerIdsForModel: (modelId: string) =>
                [...providerModels.entries()]
                    .filter(([, models]) => models.has(modelId))
                    .map(([providerId]) => providerId),
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
                permissionMode: "auto",
                providerId: "codex",
            }),
        } as unknown as InMemorySession;
        const createSubagent = vi.fn(() => child);
        const manager = new AgentSessionManager({
            repository: {
                createSubagent,
                get: (sessionId) => (sessionId === parent.id ? parent : undefined),
                listByRoot: () => [],
            },
        });

        await manager.spawn(parent.id, {
            background: true,
            description: "Use current provider",
            modelId: "shared/current",
            prompt: "Use the current provider when possible.",
        });
        expect(createSubagent).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelId: "shared/current", providerId: "codex" }),
            expect.anything(),
        );

        await manager.spawn(parent.id, {
            background: true,
            description: "Use unique provider",
            modelId: "claude/unique",
            prompt: "Use the only matching provider.",
        });
        expect(createSubagent).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelId: "claude/unique", providerId: "claude" }),
            expect.anything(),
        );

        await manager.spawn(parent.id, {
            background: true,
            description: "Use first available provider",
            modelId: "shared/ambiguous",
            prompt: "Use the best available provider.",
        });
        expect(createSubagent).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelId: "shared/ambiguous", providerId: "claude" }),
            expect.anything(),
        );

        manager.recordSuccessfulProvider("shared/ambiguous", "grok");
        await manager.spawn(parent.id, {
            background: true,
            description: "Reuse successful provider",
            modelId: "shared/ambiguous",
            prompt: "Use the provider that most recently served this model successfully.",
        });
        expect(createSubagent).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelId: "shared/ambiguous", providerId: "grok" }),
            expect.anything(),
        );

        await manager.spawn(parent.id, {
            background: true,
            description: "Reuse successful model",
            prompt: "Use the best model for this provider.",
            providerId: "grok",
        });
        expect(createSubagent).toHaveBeenLastCalledWith(
            expect.objectContaining({ modelId: "shared/ambiguous", providerId: "grok" }),
            expect.anything(),
        );
        expect(createSubagent).toHaveBeenCalledTimes(5);
    });

    it("does not propagate session-scoped attachments to spawned subagents", async () => {
        const child = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "inspect_secrets",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            subagentSummary: () => ({ status: "running" }),
            submit: vi.fn(() => ({ runId: "child-run" })),
        } as unknown as InMemorySession;
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            hasModel: () => true,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
                permissionMode: "auto",
                providerId: "codex",
            }),
            snapshot: () => ({
                projectSecretIds: [],
                secretIds: ["service"],
                sessionSecretIds: ["service"],
            }),
        } as unknown as InMemorySession;
        let childRequest: CreateSessionRequest | undefined;
        const createSubagent = vi.fn(
            (request: CreateSessionRequest, _metadata: SessionAgentMetadata) => {
                childRequest = request;
                return child;
            },
        );
        const manager = new AgentSessionManager({
            repository: {
                createSubagent,
                get: (sessionId) => (sessionId === parent.id ? parent : undefined),
                listByRoot: () => [],
            },
        });

        expect(parent.snapshot()).toMatchObject({
            secretIds: ["service"],
            sessionSecretIds: ["service"],
        });
        await manager.spawn(parent.id, {
            background: true,
            description: "Inspect without parent secrets",
            prompt: "Inspect the project.",
            taskName: "inspect_secrets",
        });

        expect(createSubagent).toHaveBeenCalledOnce();
        expect(childRequest).not.toHaveProperty("secretIds");
    });

    it("updates every subagent permission boundary with the root session", async () => {
        const changeFirst = vi.fn(async () => ({ permissionMode: "read_only" }));
        const changeSecond = vi.fn(async () => ({ permissionMode: "read_only" }));
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
        } as unknown as InMemorySession;
        const children = [changeFirst, changeSecond].map(
            (changePermissionMode, index) =>
                ({
                    changePermissionMode,
                    id: `child-${index + 1}`,
                }) as unknown as InMemorySession,
        );
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) => (sessionId === root.id ? root : undefined),
                listByRoot: () => children,
            },
        });

        await manager.changeSubagentPermissionModes(root.id, "read_only");

        expect(changeFirst).toHaveBeenCalledWith(
            { permissionMode: "read_only" },
            { updateSubagents: false },
        );
        expect(changeSecond).toHaveBeenCalledWith(
            { permissionMode: "read_only" },
            { updateSubagents: false },
        );
    });

    it("switches one retained subagent between read only and the sender mode", async () => {
        const changePermissionMode = vi.fn(async () => ({ permissionMode: "read_only" }));
        const child = {
            agentMetadata: () => ({
                depth: 1,
                description: "Inspect code",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "inspect_code",
                type: "subagent" as const,
            }),
            changePermissionMode,
            id: "child-1",
            isSubagent: () => true,
            subagentSummary: () => ({
                description: "Inspect code",
                status: "completed" as const,
            }),
            submit: vi.fn(() => ({ runId: "child-run" })),
            waitForRun: vi.fn(() => new Promise(() => {})),
        } as unknown as InMemorySession;
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                permissionMode: "auto",
            }),
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) =>
                    sessionId === parent.id ? parent : sessionId === child.id ? child : undefined,
                listByRoot: () => [child],
            },
        });

        await manager.setSubagentReadOnly(parent.id, "/root/inspect_code", true);
        manager.followUp(parent.id, "/root/inspect_code", "Inspect first.");
        await manager.setSubagentReadOnly(parent.id, "/root/inspect_code", false);
        manager.followUp(parent.id, "/root/inspect_code", "Now make the fix.");

        expect(changePermissionMode).toHaveBeenNthCalledWith(
            1,
            { permissionMode: "read_only" },
            { updateSubagents: false },
        );
        expect(changePermissionMode).toHaveBeenNthCalledWith(
            2,
            { permissionMode: "auto" },
            { updateSubagents: false },
        );
    });

    it("does not let an ancestor restore a nested subagent above its direct parent", async () => {
        const nestedChangePermissionMode = vi.fn(async () => ({ permissionMode: "auto" }));
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" as const }),
            id: "root-1",
            isSubagent: () => false,
            requestForSubagent: () => ({ permissionMode: "auto" as const }),
        } as unknown as InMemorySession;
        const directChild = {
            agentMetadata: () => ({
                depth: 1,
                parentSessionId: root.id,
                rootSessionId: root.id,
                taskName: "direct_child",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
        } as unknown as InMemorySession;
        const nestedChild = {
            agentMetadata: () => ({
                depth: 2,
                parentSessionId: directChild.id,
                rootSessionId: root.id,
                taskName: "nested_child",
                type: "subagent" as const,
            }),
            changePermissionMode: nestedChangePermissionMode,
            id: "child-2",
            isSubagent: () => true,
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) =>
                    sessionId === root.id
                        ? root
                        : sessionId === directChild.id
                          ? directChild
                          : sessionId === nestedChild.id
                            ? nestedChild
                            : undefined,
                listByRoot: () => [directChild, nestedChild],
            },
        });

        await expect(
            manager.setSubagentReadOnly(root.id, "/root/direct_child/nested_child", false),
        ).rejects.toThrow("Only an agent that started this child can change its permission mode.");
        expect(nestedChangePermissionMode).not.toHaveBeenCalled();
    });

    it("shuts down a descendant whose permission reduction cannot be persisted", async () => {
        const failedChange = vi.fn(async () => {
            throw new Error("could not persist child permission mode");
        });
        const successfulChange = vi.fn(async () => ({ permissionMode: "read_only" }));
        const failedShutdown = vi.fn(async () => {});
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
        } as unknown as InMemorySession;
        const failedChild = {
            beginShutdown: failedShutdown,
            changePermissionMode: failedChange,
            id: "child-1",
        } as unknown as InMemorySession;
        const successfulChild = {
            beginShutdown: vi.fn(async () => {}),
            changePermissionMode: successfulChange,
            id: "child-2",
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) => (sessionId === root.id ? root : undefined),
                listByRoot: () => [failedChild, successfulChild],
            },
        });

        await expect(manager.changeSubagentPermissionModes(root.id, "read_only")).rejects.toThrow(
            "could not persist child permission mode",
        );

        expect(failedShutdown).toHaveBeenCalledOnce();
        expect(successfulChange).toHaveBeenCalledOnce();
        expect(successfulChild.beginShutdown).not.toHaveBeenCalled();
    });

    it("runs background agents, reports completion, and keeps them available for follow-up", async () => {
        let status: "completed" | "error" | "running" = "running";
        let resolveCompletion: ((value: { status: "completed" }) => void) | undefined;
        const completion = new Promise<{ status: "completed" }>((resolve) => {
            resolveCompletion = resolve;
        });
        const childSubmit = vi
            .fn()
            .mockReturnValueOnce({ eventId: "event-1", runId: "run-1", sessionId: "child-1" })
            .mockReturnValueOnce({ eventId: "event-2", runId: "run-2", sessionId: "child-1" });
        const abort = vi.fn(() => ({ aborted: true }));
        const waitForRun = vi.fn(() => completion);
        const child = {
            agentIdentity: () => ({ agentId: "agent-2", folder: "workspace" }),
            abort,
            agentMetadata: () => ({
                depth: 1,
                description: "Inspect code",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "inspect_code",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            lastErrorMessage: () => "The child provider rejected the request.",
            snapshot: () => ({
                snapshot: {
                    messages: [
                        {
                            blocks: [{ text: "The inspection is complete.", type: "text" }],
                            id: "message-1",
                            role: "agent",
                        },
                    ],
                },
            }),
            subagentSummary: () => ({
                agentId: "agent-2",
                createdAt: 2,
                depth: 1,
                description: "Inspect code",
                id: "child-1",
                modelId: "openai/gpt-5.5",
                parentSessionId: "root-1",
                status,
                taskName: "inspect_code",
                updatedAt: 3,
            }),
            submit: childSubmit,
            waitForRun,
        } as unknown as InMemorySession;
        const deliverNotification = vi.fn();
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            deliverNotification,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
            }),
        } as unknown as InMemorySession;
        let created = false;
        const sessions = new Map([
            ["root-1", parent],
            ["child-1", child],
        ]);
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: () => {
                    created = true;
                    return child;
                },
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => (created ? [child] : []),
            },
        });

        await expect(
            manager.spawn("root-1", {
                background: true,
                description: "Inspect code",
                prompt: "Inspect the codebase.",
                taskName: "inspect_code",
            }),
        ).resolves.toMatchObject({
            agentId: "agent-2",
            path: "/root/inspect_code",
            status: "running",
        });
        expect(manager.list("root-1")).toEqual([
            expect.objectContaining({
                agentId: "agent-2",
                path: "/root/inspect_code",
                status: "running",
            }),
        ]);

        status = "completed";
        resolveCompletion?.({ status: "completed" });
        await vi.waitFor(() => expect(deliverNotification).toHaveBeenCalledOnce());
        expect(deliverNotification).toHaveBeenCalledWith({
            displayText: 'Background work "Inspect code" completed.',
            text: expect.stringMatching(
                /Agent ID: agent-2\nPath: \/root\/inspect_code\nStatus: completed\nResult: The inspection is complete\./u,
            ),
        });
        expect(manager.inspect("root-1", "agent-2")).toMatchObject({
            agentId: "agent-2",
            output: "The inspection is complete.",
            status: "completed",
        });
        expect(() => manager.inspect("root-1", "child-1")).toThrow(
            "Subagent 'child-1' was not found.",
        );
        expect(() => manager.inspect("root-1", "inspect_code")).toThrow(
            "Subagent 'inspect_code' was not found.",
        );
        status = "error";
        expect(manager.inspect("root-1", "/root/inspect_code")).toMatchObject({
            output: "The child provider rejected the request.",
            status: "error",
        });
        status = "completed";

        expect(
            manager.followUp("root-1", "/root/inspect_code", "Check one more file.", "high"),
        ).toMatchObject({ agentId: "agent-2" });
        expect(childSubmit).toHaveBeenLastCalledWith({
            agentMessageTriggerTurn: true,
            effort: "high",
            provenance: "agent",
            text: "Check one more file.",
        });
        childSubmit.mockImplementationOnce(() => {
            throw new Error("Model 'openai/gpt-5.5' does not support 'ultra' reasoning.");
        });
        expect(() =>
            manager.followUp("root-1", "/root/inspect_code", "Try unsupported effort.", "ultra"),
        ).toThrow("Model 'openai/gpt-5.5' does not support 'ultra' reasoning.");
        expect(childSubmit).toHaveBeenCalledTimes(3);
        await vi.waitFor(() => expect(waitForRun).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(deliverNotification).toHaveBeenCalledTimes(2));
        expect(manager.interrupt("root-1", "/root/inspect_code")).toMatchObject({
            status: "completed",
        });
        expect(abort).toHaveBeenCalledOnce();
        await expect(manager.wait("root-1", 0)).resolves.toMatchObject({
            agents: [
                expect.objectContaining({
                    agentId: "agent-2",
                    path: "/root/inspect_code",
                }),
            ],
            timedOut: false,
        });
    });

    it("reports a failed child when its background monitor rejects", async () => {
        const deliverNotification = vi.fn();
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            deliverNotification,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
            }),
        } as unknown as InMemorySession;
        const child = {
            agentIdentity: () => ({ agentId: "agent-2", folder: "workspace" }),
            agentMetadata: () => ({
                depth: 1,
                description: "Inspect code",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "inspect_code",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            lastErrorMessage: () => "The child process disconnected.",
            snapshot: () => ({ snapshot: { messages: [] } }),
            subagentSummary: () => ({
                agentId: "agent-2",
                createdAt: 2,
                depth: 1,
                description: "Inspect code",
                id: "child-1",
                modelId: "openai/gpt-5.5",
                parentSessionId: "root-1",
                status: "error" as const,
                taskName: "inspect_code",
                updatedAt: 3,
            }),
            submit: vi.fn(() => ({
                eventId: "event-1",
                runId: "run-1",
                sessionId: "child-1",
            })),
            waitForRun: vi.fn(async () => {
                throw new Error("The background monitor lost the child completion.");
            }),
        } as unknown as InMemorySession;
        const sessions = new Map([
            ["root-1", parent],
            ["child-1", child],
        ]);
        let created = false;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: () => {
                    created = true;
                    return child;
                },
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => (created ? [child] : []),
            },
        });

        await manager.spawn("root-1", {
            background: true,
            description: "Inspect code",
            prompt: "Inspect the codebase.",
            taskName: "inspect_code",
        });

        await vi.waitFor(() => expect(deliverNotification).toHaveBeenCalledOnce());
        expect(deliverNotification).toHaveBeenCalledWith({
            displayText: 'Background work "Inspect code" failed.',
            text: expect.stringMatching(
                /Agent ID: agent-2\nPath: \/root\/inspect_code\nStatus: error\nResult: The child process disconnected\./u,
            ),
        });
    });

    it("delivers each background completion immediately", async () => {
        const completions = new Map<string, (value: { status: "completed" }) => void>();
        const statuses = new Map<string, "completed" | "running">();
        const children = ["child-1", "child-2"].map((id, index) => {
            const taskName = `task_${index + 1}`;
            statuses.set(id, "running");
            const completion = new Promise<{ status: "completed" }>((resolve) => {
                completions.set(id, resolve);
            });
            return {
                agentMetadata: () => ({
                    depth: 1,
                    description: taskName,
                    parentSessionId: "root-1",
                    rootSessionId: "root-1",
                    taskName,
                    type: "subagent" as const,
                }),
                id,
                isSubagent: () => true,
                snapshot: () => ({
                    snapshot: {
                        messages: [
                            {
                                blocks: [{ text: `${taskName} result`, type: "text" }],
                                id: `${id}-message`,
                                role: "agent",
                            },
                        ],
                    },
                }),
                subagentSummary: () => ({
                    agentId: `${id}-agent`,
                    createdAt: index,
                    depth: 1,
                    description: taskName,
                    id,
                    modelId: "openai/gpt-5.5",
                    parentSessionId: "root-1",
                    status: statuses.get(id) ?? "running",
                    taskName,
                    updatedAt: index,
                }),
                submit: vi.fn(() => ({
                    eventId: `${id}-event`,
                    runId: `${id}-run`,
                    sessionId: id,
                })),
                waitForRun: () => completion,
            } as unknown as InMemorySession;
        });
        const deliverNotification = vi.fn();
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            deliverNotification,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
            }),
        } as unknown as InMemorySession;
        const sessions = new Map<string, InMemorySession>([["root-1", parent]]);
        let nextChild = 0;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: () => {
                    const child = children[nextChild++];
                    if (child === undefined) throw new Error("No child session available.");
                    sessions.set(child.id, child);
                    return child;
                },
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => children.slice(0, nextChild),
            },
        });

        await Promise.all([
            manager.spawn("root-1", {
                background: true,
                description: "First task",
                prompt: "Do the first task.",
                taskName: "task_1",
            }),
            manager.spawn("root-1", {
                background: true,
                description: "Second task",
                prompt: "Do the second task.",
                taskName: "task_2",
            }),
        ]);

        statuses.set("child-1", "completed");
        statuses.set("child-2", "completed");
        completions.get("child-1")?.({ status: "completed" });
        completions.get("child-2")?.({ status: "completed" });

        await vi.waitFor(() => expect(deliverNotification).toHaveBeenCalledTimes(2));
        expect(deliverNotification).toHaveBeenNthCalledWith(1, {
            displayText: 'Background work "task_1" completed.',
            text: expect.stringContaining("task_1 result"),
        });
        expect(deliverNotification).toHaveBeenNthCalledWith(2, {
            displayText: 'Background work "task_2" completed.',
            text: expect.stringContaining("task_2 result"),
        });
    });

    it("cascades the parent step abort into the active child", async () => {
        let childStatus: "aborted" | "running" = "running";
        let resolveCompletion: ((value: { status: "aborted" }) => void) | undefined;
        const completion = new Promise<{ status: "aborted" }>((resolve) => {
            resolveCompletion = resolve;
        });
        const abort = vi.fn(() => {
            childStatus = "aborted";
            resolveCompletion?.({ status: "aborted" });
            return { aborted: true };
        });
        const child = {
            abort,
            agentMetadata: () => ({
                depth: 1,
                description: "Inspect the code",
                parentSessionId: "session-1",
                rootSessionId: "session-1",
                taskName: "inspect_code",
                type: "subagent" as const,
            }),
            id: "subagent-1",
            isSubagent: () => true,
            snapshot: () => ({ snapshot: { messages: [] } }),
            subagentSummary: () => ({
                agentId: "agent-2",
                createdAt: 2,
                depth: 1,
                description: "Inspect the code",
                id: "subagent-1",
                modelId: "openai/gpt-5.5",
                parentSessionId: "session-1",
                status: childStatus,
                updatedAt: 3,
            }),
            submit: () => ({ eventId: "event-1", runId: "run-1", sessionId: "subagent-1" }),
            waitForRun: () => completion,
        } as unknown as InMemorySession;
        const recordSubagentChanged = vi.fn();
        const parent = {
            id: "session-1",
            agentMetadata: () => ({
                depth: 0,
                rootSessionId: "session-1",
                type: "primary" as const,
            }),
            isSubagent: () => false,
            recordSubagentChanged,
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
            }),
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: () => child,
                get: (sessionId) => (sessionId === "subagent-1" ? child : parent),
                listByRoot: () => [],
            },
        });
        const controller = new AbortController();

        const run = manager.spawn(
            "session-1",
            { description: "Inspect the code", prompt: "Review the implementation." },
            controller.signal,
        );
        controller.abort();

        await expect(run).resolves.toMatchObject({
            agentId: "agent-2",
            status: "aborted",
        });
        expect(abort).toHaveBeenCalledOnce();
        expect(recordSubagentChanged).toHaveBeenCalledTimes(2);
    });

    it("hard-stops every descendant while keeping each saved session reusable", async () => {
        const statuses = new Map<string, "aborted" | "running" | "suspended">([
            ["child-1", "running"],
            ["grandchild-1", "suspended"],
        ]);
        const sessions = new Map<string, InMemorySession>();
        const makeChild = (id: string, parentSessionId: string, taskName: string) => {
            const abort = vi.fn(() => {
                statuses.set(id, "aborted");
                return { aborted: true };
            });
            const clearSuspension = vi.fn(() => statuses.set(id, "aborted"));
            const submit = vi.fn(() => {
                statuses.set(id, "running");
                return { eventId: `${id}-event`, runId: `${id}-run`, sessionId: id };
            });
            const session = {
                abort,
                agentMetadata: () => ({
                    depth: parentSessionId === "root-1" ? 1 : 2,
                    description: taskName,
                    parentSessionId,
                    rootSessionId: "root-1",
                    taskName,
                    type: "subagent" as const,
                }),
                clearSuspension,
                id,
                isSubagent: () => true,
                recordSubagentChanged: vi.fn(),
                snapshot: () => ({ snapshot: { messages: [] } }),
                subagentSummary: () => ({
                    agentId: `${id}-agent`,
                    description: taskName,
                    id,
                    parentSessionId,
                    status: statuses.get(id),
                }),
                submit,
                waitForRun: () => new Promise(() => undefined),
            } as unknown as InMemorySession;
            sessions.set(id, session);
            return { abort, clearSuspension, session, submit };
        };
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
        } as unknown as InMemorySession;
        sessions.set(root.id, root);
        const child = makeChild("child-1", root.id, "audit_code");
        const grandchild = makeChild("grandchild-1", child.session.id, "inspect_tests");
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => [child.session, grandchild.session],
            },
        });

        await expect(manager.stopDescendants(root.id)).resolves.toBe(2);

        expect(child.abort).toHaveBeenCalledWith({ stopDescendants: false });
        expect(grandchild.abort).not.toHaveBeenCalled();
        expect(grandchild.clearSuspension).toHaveBeenCalledOnce();
        expect(manager.list(root.id)).toEqual([
            expect.objectContaining({ agentId: "child-1-agent", status: "aborted" }),
            expect.objectContaining({ agentId: "grandchild-1-agent", status: "aborted" }),
        ]);

        expect(manager.followUp(root.id, "/root/audit_code", "Inspect one more file.")).toEqual(
            expect.objectContaining({ agentId: "child-1-agent", status: "running" }),
        );
        expect(child.submit).toHaveBeenCalledWith({
            agentMessageTriggerTurn: true,
            provenance: "agent",
            text: "Inspect one more file.",
        });
    });

    it("suspends active descendants until each retained session receives follow-up work", async () => {
        const statuses = new Map<string, "aborted" | "completed" | "running" | "suspended">([
            ["child-1", "running"],
            ["grandchild-1", "running"],
            ["child-2", "completed"],
        ]);
        const sessions = new Map<string, InMemorySession>();
        const makeChild = (
            id: string,
            parentSessionId: string,
            depth: number,
            taskName: string,
        ) => {
            const abort = vi.fn(() => {
                statuses.set(id, "aborted");
                return { aborted: true };
            });
            const suspendByParent = vi.fn(() => {
                statuses.set(id, "suspended");
            });
            const submit = vi.fn(() => {
                statuses.set(id, "running");
                return { eventId: `${id}-event`, runId: `${id}-run`, sessionId: id };
            });
            const session = {
                abort,
                agentMetadata: () => ({
                    depth,
                    description: taskName,
                    parentSessionId,
                    rootSessionId: "root-1",
                    taskName,
                    type: "subagent" as const,
                }),
                id,
                isSubagent: () => true,
                clearSuspension: vi.fn(() => {
                    if (statuses.get(id) === "suspended") statuses.set(id, "aborted");
                }),
                recordSubagentChanged: vi.fn(),
                snapshot: () => ({ snapshot: { messages: [] } }),
                subagentSummary: () => ({
                    agentId: `${id}-agent`,
                    createdAt: depth,
                    depth,
                    description: taskName,
                    id,
                    modelId: "openai/gpt-5.5",
                    parentSessionId,
                    status: statuses.get(id),
                    taskName,
                    updatedAt: depth,
                }),
                submit,
                suspendByParent,
                waitForRun: () => new Promise(() => undefined),
            } as unknown as InMemorySession;
            sessions.set(id, session);
            return { abort, session, submit, suspendByParent };
        };
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            recordSubagentsSuspended: vi.fn(),
        } as unknown as InMemorySession;
        sessions.set(root.id, root);
        const child = makeChild("child-1", root.id, 1, "audit_code");
        const grandchild = makeChild("grandchild-1", child.session.id, 2, "inspect_tests");
        const completed = makeChild("child-2", root.id, 1, "finished_task");
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => [child.session, grandchild.session, completed.session],
            },
        });

        await expect(manager.pauseDescendants(root.id)).resolves.toBe(2);

        expect(child.suspendByParent).toHaveBeenCalledOnce();
        expect(grandchild.suspendByParent).toHaveBeenCalledOnce();
        expect(completed.abort).not.toHaveBeenCalled();
        expect(manager.list(root.id)).toEqual([
            expect.objectContaining({ agentId: "child-1-agent", status: "suspended" }),
            expect.objectContaining({ agentId: "grandchild-1-agent", status: "suspended" }),
            expect.objectContaining({ agentId: "child-2-agent", status: "completed" }),
        ]);
        expect(root.recordSubagentsSuspended).toHaveBeenCalledWith([
            expect.objectContaining({ agentId: "child-1-agent", status: "suspended" }),
            expect.objectContaining({ agentId: "grandchild-1-agent", status: "suspended" }),
        ]);

        expect(manager.followUp(root.id, "/root/audit_code", "Continue the audit.")).toEqual(
            expect.objectContaining({ agentId: "child-1-agent", status: "running" }),
        );

        expect(child.submit).toHaveBeenCalledWith({
            agentMessageTriggerTurn: true,
            provenance: "agent",
            text: "Continue the audit.",
        });
        expect(grandchild.submit).not.toHaveBeenCalled();
        expect(completed.submit).not.toHaveBeenCalled();
        expect(manager.list(root.id)).toEqual([
            expect.objectContaining({ agentId: "child-1-agent", status: "running" }),
            expect.objectContaining({ agentId: "grandchild-1-agent", status: "suspended" }),
            expect.objectContaining({ agentId: "child-2-agent", status: "completed" }),
        ]);
    });

    it("does not suspend children owned by a workflow that is still running", async () => {
        const suspendByParent = vi.fn();
        const workflowChild = {
            agentMetadata: () => ({
                depth: 1,
                description: "Workflow child",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "workflow_run-1_1",
                type: "subagent" as const,
            }),
            id: "workflow-child-1",
            isSubagent: () => true,
            subagentSummary: () => ({ status: "running" }),
            suspendByParent,
        } as unknown as InMemorySession;
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            getWorkflow: (runId: string) =>
                runId === "run-1" ? ({ status: "running" } as const) : undefined,
            id: "root-1",
            recordSubagentsSuspended: vi.fn(),
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) =>
                    sessionId === root.id
                        ? root
                        : sessionId === workflowChild.id
                          ? workflowChild
                          : undefined,
                listByRoot: () => [workflowChild],
            },
        });

        await expect(manager.pauseDescendants(root.id)).resolves.toBe(0);
        expect(suspendByParent).not.toHaveBeenCalled();
        expect(root.recordSubagentsSuspended).toHaveBeenCalledWith([]);
    });

    it("excludes workspace-archived subagents from collaboration lists and waits", async () => {
        const archived = {
            agentMetadata: () => ({
                depth: 1,
                description: "Archived child",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "archived_child",
                type: "subagent" as const,
            }),
            id: "archived-child-1",
            isSubagent: () => true,
            subagentSummary: () => ({
                agentId: "archived-agent-1",
                createdAt: 1,
                depth: 1,
                description: "Archived child",
                id: "archived-child-1",
                modelId: "openai/gpt-5.6-sol",
                parentSessionId: "root-1",
                status: "archived" as const,
                taskName: "archived_child",
                updatedAt: 2,
            }),
        } as unknown as InMemorySession;
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) =>
                    sessionId === root.id ? root : sessionId === archived.id ? archived : undefined,
                listByRoot: () => [archived],
            },
        });

        expect(manager.list(root.id)).toEqual([]);
        await expect(manager.wait(root.id, 0)).resolves.toEqual({
            agents: [],
            timedOut: false,
        });
    });

    it("waits for active work instead of returning an older completed agent", async () => {
        let activeStatus: "completed" | "running" = "running";
        const makeChild = (id: string, taskName: string, status: () => "completed" | "running") =>
            ({
                agentMetadata: () => ({
                    depth: 1,
                    description: taskName,
                    parentSessionId: "root-1",
                    rootSessionId: "root-1",
                    taskName,
                    type: "subagent" as const,
                }),
                id,
                isSubagent: () => true,
                subagentSummary: () => ({
                    agentId: `${id}-agent`,
                    createdAt: 1,
                    depth: 1,
                    description: taskName,
                    id,
                    modelId: "openai/gpt-5.5",
                    parentSessionId: "root-1",
                    status: status(),
                    taskName,
                    updatedAt: 2,
                }),
            }) as unknown as InMemorySession;
        const completed = makeChild("child-1", "older_task", () => "completed");
        const active = makeChild("child-2", "active_task", () => activeStatus);
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (sessionId) =>
                    sessionId === "root-1" ? root : sessionId === "child-1" ? completed : active,
                listByRoot: () => [completed, active],
            },
        });
        let settled = false;
        const waiting = manager.wait("root-1", 500).then((result) => {
            settled = true;
            return result;
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);
        activeStatus = "completed";

        await expect(waiting).resolves.toEqual({
            agents: [expect.objectContaining({ agentId: "child-2-agent", status: "completed" })],
            timedOut: false,
        });
    });

    it("rejects a child beyond the configured nesting depth", async () => {
        const parent = {
            agentMetadata: () => ({
                depth: 3,
                parentSessionId: "subagent-2",
                rootSessionId: "session-1",
                type: "subagent" as const,
            }),
        } as unknown as InMemorySession;
        const createSubagent = vi.fn();
        const manager = new AgentSessionManager({
            maxDepth: 3,
            repository: {
                createSubagent,
                get: () => parent,
                listByRoot: () => [],
            },
        });

        await expect(
            manager.spawn("subagent-3", {
                description: "Exceed the limit",
                prompt: "Start another child.",
            }),
        ).rejects.toThrow("limited to 3 nested levels");
        expect(createSubagent).not.toHaveBeenCalled();
    });

    it("rejects a spawn when the active-agent limit is full", async () => {
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            encryptedAgentTransportScope: () => '["codex",null]',
            id: "root-1",
            isCodexV2Collaboration: () => true,
        } as unknown as InMemorySession;
        const active = Array.from({ length: 3 }, (_, index) => {
            const id = `child-${index + 1}`;
            return {
                subagentSummary: () => ({
                    agentId: `${id}-agent`,
                    createdAt: index,
                    depth: 1,
                    description: `Active task ${index + 1}`,
                    id,
                    modelId: "openai/gpt-5.5",
                    parentSessionId: "root-1",
                    status: "running" as const,
                    updatedAt: index,
                }),
            } as unknown as InMemorySession;
        });
        const createSubagent = vi.fn();
        const manager = new AgentSessionManager({
            repository: {
                createSubagent,
                get: () => parent,
                listByRoot: () => active,
            },
        });

        await expect(
            manager.spawn("root-1", {
                description: "One task too many",
                prompt: "Do more work.",
            }),
        ).rejects.toThrow("No more than 3 subagents can run at once");
        expect(createSubagent).not.toHaveBeenCalled();
    });

    it("queues workflow agents until an active-agent slot is available", async () => {
        let activeStatus: "completed" | "running" = "running";
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/tmp/rig-manager-test",
                modelId: "openai/gpt-5.5",
            }),
        } as unknown as InMemorySession;
        const active = {
            agentMetadata: () => ({
                depth: 1,
                description: "Active task",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "active_task",
                type: "subagent" as const,
            }),
            subagentSummary: () => ({
                agentId: "active-agent",
                createdAt: 1,
                depth: 1,
                description: "Active task",
                id: "active-child",
                modelId: "openai/gpt-5.5",
                parentSessionId: "root-1",
                status: activeStatus,
                updatedAt: 1,
            }),
        } as unknown as InMemorySession;
        const queued = {
            abort: vi.fn(),
            agentMetadata: () => ({
                depth: 1,
                description: "Queued task",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "queued_task",
                type: "subagent" as const,
            }),
            id: "queued-child",
            isSubagent: () => true,
            snapshot: () => ({
                snapshot: {
                    messages: [
                        {
                            blocks: [{ text: "Queued result", type: "text" }],
                            id: "result",
                            role: "agent",
                        },
                    ],
                },
            }),
            subagentSummary: () => ({
                agentId: "queued-agent",
                createdAt: 2,
                depth: 1,
                description: "Queued task",
                id: "queued-child",
                modelId: "openai/gpt-5.5",
                parentSessionId: "root-1",
                status: "completed" as const,
                taskName: "queued_task",
                updatedAt: 2,
            }),
            submit: vi.fn(() => ({ eventId: "event", runId: "run", sessionId: "queued-child" })),
            waitForRun: vi.fn(async () => ({ status: "completed" as const })),
        } as unknown as InMemorySession;
        let created = false;
        const createSubagent = vi.fn(() => {
            created = true;
            return queued;
        });
        const manager = new AgentSessionManager({
            maxActive: 1,
            repository: {
                createSubagent,
                get: () => parent,
                listByRoot: () => (created ? [active, queued] : [active]),
            },
        });

        const spawning = manager.spawn("root-1", {
            description: "Queued task",
            prompt: "Run after the active task.",
            taskName: "queued_task",
            waitForSlot: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(createSubagent).not.toHaveBeenCalled();

        activeStatus = "completed";

        await expect(spawning).resolves.toMatchObject({
            output: "Queued result",
            status: "completed",
        });
        expect(createSubagent).toHaveBeenCalledOnce();
    });

    it("routes subagent task operations to the root session", () => {
        const root = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "session-1", type: "primary" }),
        } as unknown as InMemorySession;
        const child = {
            agentMetadata: () => ({
                depth: 1,
                rootSessionId: "session-1",
                type: "subagent",
            }),
        } as unknown as InMemorySession;
        const sessions = new Map([
            ["session-1", root],
            ["subagent-1", child],
        ]);
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: () => child,
                get: (sessionId) => sessions.get(sessionId),
                listByRoot: () => [child],
            },
        });

        expect(manager.taskSession("subagent-1")).toBe(root);
        expect(manager.taskSession("session-1")).toBe(root);
    });

    it("starts a sidebar-hidden subagent in an owned ready workspace", async () => {
        const child = {
            agentMetadata: () => ({
                depth: 1,
                description: "Fix parser",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "fix_parser",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            subagentSummary: () => ({ status: "running" }),
            submit: vi.fn(() => ({ runId: "child-run" })),
        } as unknown as InMemorySession;
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            effortLevelsForModel: () => ["low", "medium", "high"],
            hasModel: () => true,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/project",
                docker: {
                    image: "parent:latest",
                    name: "rig-project-project-1-1",
                    workingDirectory: "/workspace",
                },
                modelId: "openai/gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
            }),
            snapshot: () => ({ projectId: "project-1" }),
        } as unknown as InMemorySession;
        const createSubagent = vi.fn(() => child);
        const configureWorkspaceRequest = vi.fn((request: CreateSessionRequest) => ({
            ...request,
            docker: {
                image: "workspace:latest",
                name: "rig-workspace-workspace-1-1",
                workingDirectory: "/workspace",
            },
        }));
        const manager = new AgentSessionManager({
            repository: {
                configureWorkspaceRequest,
                createSubagent,
                get: (id) => (id === parent.id ? parent : undefined),
                listByRoot: () => [],
                ownedWorkspace: (ownerSessionId, projectId, workspaceId) =>
                    ownerSessionId === parent.id &&
                    projectId === "project-1" &&
                    workspaceId === "workspace-1"
                        ? ({
                              id: workspaceId,
                              name: "Parser",
                              path: "/workspaces/parser",
                              projectId,
                              status: "ready",
                          } as ProjectWorkspace)
                        : undefined,
            },
        });

        await manager.spawnInWorkspace(parent.id, {
            background: true,
            description: "Fix parser",
            effort: "high",
            modelId: "openai/gpt-5.6-terra",
            prompt: "Repair the parser.",
            providerId: "codex",
            readOnly: true,
            serviceTier: "fast",
            taskName: "fix_parser",
            workspaceId: "workspace-1",
        });

        expect(createSubagent).toHaveBeenCalledWith(
            expect.objectContaining({
                cwd: "/workspaces/parser",
                docker: expect.objectContaining({
                    name: "rig-workspace-workspace-1-1",
                }),
                effort: "high",
                modelId: "openai/gpt-5.6-terra",
                permissionMode: "read_only",
                providerId: "codex",
                serviceTier: "fast",
                workspaceId: "workspace-1",
            }),
            expect.objectContaining({
                parentSessionId: parent.id,
                type: "subagent",
            }),
        );
        expect(configureWorkspaceRequest).toHaveBeenCalledOnce();
        await expect(
            manager.spawnInWorkspace(parent.id, {
                description: "Invade",
                effort: "medium",
                modelId: "openai/gpt-5.6-sol",
                prompt: "Do not run.",
                providerId: "codex",
                workspaceId: "workspace-owned-by-someone-else",
            }),
        ).rejects.toThrow("not created by the current session");
        expect(createSubagent).toHaveBeenCalledOnce();
    });

    it("starts a delegated conversation the user can see and take over", async () => {
        const delegated = {
            agentIdentity: () => ({ agentId: "delegate-agent", folder: "changelog" }),
            agentMetadata: () => ({
                delegatedBySessionId: "root-1",
                depth: 0,
                rootSessionId: "delegate-1",
                type: "primary" as const,
            }),
            id: "delegate-1",
            isSubagent: () => false,
            submit: vi.fn(() => ({ runId: "delegate-run" })),
            waitForRun: vi.fn(() => new Promise(() => {})),
        } as unknown as InMemorySession;
        const delegator = delegatorSession({
            effortLevelsForModel: () => ["medium", "high"],
            hasModel: (modelId, providerId) =>
                modelId === "anthropic/sonnet-5" && providerId === "claude",
            providerIdsForModel: (modelId) => (modelId === "anthropic/sonnet-5" ? ["claude"] : []),
        });
        const createDelegatedSession = vi.fn(() => delegated);
        let workspacePresence: ProjectWorkspace["presence"] = "missing";
        const manager = new AgentSessionManager({
            repository: {
                createDelegatedSession,
                createSubagent: vi.fn(),
                get: (id) => (id === delegator.id ? delegator : undefined),
                listByRoot: () => [],
                workspace: (projectId, workspaceId) =>
                    projectId === "project-1" && workspaceId === "workspace-2"
                        ? ({
                              id: workspaceId,
                              name: "Changelog",
                              path: "/workspaces/changelog",
                              presence: workspacePresence,
                              projectId,
                              status: "ready",
                          } as ProjectWorkspace)
                        : undefined,
            },
        });

        const request = {
            effort: "high",
            modelId: "anthropic/sonnet-5",
            prompt: "Update the changelog.",
            readOnly: true,
            serviceTier: "fast" as const,
            title: "Update the changelog",
            workspaceId: "workspace-2",
        };
        await expect(manager.delegate(delegator.id, request)).rejects.toThrow(
            "directory is unavailable",
        );
        workspacePresence = "present";
        await expect(manager.delegate(delegator.id, request)).resolves.toEqual({
            agentId: "delegate-agent",
            projectId: "project-1",
            sessionId: "delegate-1",
            title: "Update the changelog",
            workspaceId: "workspace-2",
            workspacePath: "/workspaces/changelog",
        });
        expect(createDelegatedSession).toHaveBeenCalledWith(
            expect.objectContaining({
                cwd: "/workspaces/changelog",
                effort: "high",
                modelId: "anthropic/sonnet-5",
                permissionMode: "read_only",
                projectId: "project-1",
                providerId: "claude",
                serviceTier: "fast",
                trackUnread: true,
                workspaceId: "workspace-2",
            }),
            expect.objectContaining({
                delegatedBySessionId: "root-1",
                description: "Update the changelog",
                type: "primary",
            }),
            expect.any(String),
        );
        await expect(
            manager.delegate(delegator.id, {
                effort: "medium",
                modelId: "openai/gpt-5.6-sol",
                prompt: "Nope.",
                providerId: "codex",
                workspaceId: "missing-workspace",
            }),
        ).rejects.toThrow("was not found in that project");
    });

    it("tells the delegator when delegated work fails", async () => {
        const delegated = {
            agentIdentity: () => ({
                agentId: "delegate-agent",
                folder: "changelog",
                title: "Update the changelog",
            }),
            agentMetadata: () => ({
                delegatedBySessionId: "root-1",
                depth: 0,
                rootSessionId: "delegate-1",
                type: "primary" as const,
            }),
            id: "delegate-1",
            isSubagent: () => false,
            submit: vi.fn(() => ({ runId: "delegate-run" })),
            waitForRun: vi.fn(async () => ({
                errorMessage: "API Error: 500 Internal server error.",
                status: "error" as const,
            })),
        } as unknown as InMemorySession;
        const deliverNotification = vi.fn();
        const delegator = delegatorSession({
            deliverNotification,
            effortLevelsForModel: () => ["medium"],
            hasModel: () => true,
        });
        const manager = new AgentSessionManager({
            repository: {
                createDelegatedSession: () => delegated,
                createSubagent: vi.fn(),
                get: (id) => (id === delegator.id ? delegator : undefined),
                listByRoot: () => [],
                workspace: () =>
                    ({
                        id: "workspace-2",
                        name: "Changelog",
                        path: "/workspaces/changelog",
                        projectId: "project-1",
                        status: "ready",
                    }) as ProjectWorkspace,
            },
        });

        await manager.delegate(delegator.id, {
            effort: "medium",
            modelId: "openai/gpt-5.6-sol",
            prompt: "Update the changelog.",
            title: "Update the changelog",
            workspaceId: "workspace-2",
        });

        await vi.waitFor(() => expect(deliverNotification).toHaveBeenCalledOnce());
        expect(deliverNotification).toHaveBeenCalledWith({
            displayText: 'Delegated work in "Update the changelog" failed.',
            text: expect.stringMatching(
                /Status: error\nResult: API Error: 500 Internal server error\./u,
            ),
        });
    });

    it("tells the delegator what the user said when they take a delegated session over", () => {
        const deliverNotification = vi.fn();
        const delegator = delegatorSession({ deliverNotification });
        const delegated = {
            agentIdentity: () => ({
                agentId: "delegate-agent",
                folder: "changelog",
                title: "Update the changelog",
            }),
            agentMetadata: () => ({
                delegatedBySessionId: "root-1",
                depth: 0,
                rootSessionId: "delegate-1",
                type: "primary" as const,
            }),
            id: "delegate-1",
            isSubagent: () => false,
        } as unknown as InMemorySession;
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (id) =>
                    id === delegator.id ? delegator : id === delegated.id ? delegated : undefined,
                listByRoot: () => [],
            },
        });

        manager.notifyDelegatorOfUserMessage(delegated.id, "Stop and rewrite the summary.");

        expect(deliverNotification).toHaveBeenCalledOnce();
        const notification = deliverNotification.mock.calls[0]![0] as {
            displayText: string;
            text: string;
        };
        expect(notification.displayText).toBe(
            'The user replied in "Update the changelog" themselves.',
        );
        expect(notification.text).toContain("Stop and rewrite the summary.");
        expect(notification.text).toContain("They are steering it now.");
    });

    it("keeps another project's workspaces and conversations behind cross-workspace access", () => {
        const delegator = delegatorSession();
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (id) => (id === delegator.id ? delegator : undefined),
                listByRoot: () => [],
                listProjectSessions: () => [],
                listProjectWorkspaces: () => [],
            },
        });

        expect(() =>
            manager.listWorkspaces(delegator.id, "project-2", { crossWorkspace: false }),
        ).toThrow("features.cross_workspace");
        expect(
            manager.listWorkspaces(delegator.id, "project-1", { crossWorkspace: false }),
        ).toEqual([]);
        expect(() =>
            manager.listSessions(
                delegator.id,
                { projectId: "project-2" },
                { crossWorkspace: false },
            ),
        ).toThrow("features.cross_workspace");
        expect(
            manager.listSessions(
                delegator.id,
                { projectId: "project-2" },
                { crossWorkspace: true },
            ),
        ).toEqual([]);
    });

    it("marks a workspace ended as soon as archival begins", () => {
        const delegator = delegatorSession();
        const manager = new AgentSessionManager({
            repository: {
                createSubagent: vi.fn(),
                get: (id) => (id === delegator.id ? delegator : undefined),
                listByRoot: () => [],
                listProjectWorkspaces: () => [
                    {
                        id: "workspace-1",
                        name: "Finished work",
                        path: "/workspaces/finished",
                        projectId: "project-1",
                        status: "archiving",
                    } as ProjectWorkspace,
                ],
            },
        });

        expect(manager.listWorkspaces(delegator.id, undefined, { crossWorkspace: false })).toEqual([
            {
                archived: true,
                id: "workspace-1",
                name: "Finished work",
                path: "/workspaces/finished",
                projectId: "project-1",
                status: "archiving",
            },
        ]);
    });

    it("waits for an owned workspace to become ready before starting its agent", async () => {
        const child = {
            agentMetadata: () => ({
                depth: 1,
                description: "Wait for setup",
                parentSessionId: "root-1",
                rootSessionId: "root-1",
                taskName: "wait_for_setup",
                type: "subagent" as const,
            }),
            id: "child-1",
            isSubagent: () => true,
            subagentSummary: () => ({ status: "running" }),
            submit: vi.fn(() => ({ runId: "child-run" })),
        } as unknown as InMemorySession;
        const parent = {
            agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
            effortLevelsForModel: () => ["low", "medium", "high"],
            hasModel: () => true,
            id: "root-1",
            isSubagent: () => false,
            recordSubagentChanged: vi.fn(),
            requestForSubagent: () => ({
                cwd: "/project",
                modelId: "openai/gpt-5.6-sol",
                permissionMode: "auto",
                providerId: "codex",
            }),
            snapshot: () => ({ projectId: "project-1" }),
        } as unknown as InMemorySession;
        const createSubagent = vi.fn(() => child);
        let workspacePresence: ProjectWorkspace["presence"];
        let workspaceStatus: ProjectWorkspace["status"] = "initializing";
        const ready = deferred<ProjectWorkspace>();
        const waitForWorkspaceReady = vi.fn(() => ready.promise);
        const manager = new AgentSessionManager({
            repository: {
                createSubagent,
                get: (id) => (id === parent.id ? parent : undefined),
                listByRoot: () => [],
                ownedWorkspace: () =>
                    ({
                        id: "workspace-1",
                        name: "Setup",
                        path: "/workspaces/setup",
                        presence: workspacePresence,
                        projectId: "project-1",
                        status: workspaceStatus,
                    }) as ProjectWorkspace,
                waitForWorkspaceReady,
            },
        });

        const request = {
            background: true,
            description: "Wait for setup",
            effort: "medium",
            modelId: "openai/gpt-5.6-sol",
            prompt: "Start only when setup finishes.",
            providerId: "codex",
            taskName: "wait_for_setup",
            workspaceId: "workspace-1",
        };
        const spawned = manager.spawnInWorkspace(parent.id, request);
        await Promise.resolve();
        expect(waitForWorkspaceReady).toHaveBeenCalledWith("project-1", "workspace-1", undefined);
        expect(createSubagent).not.toHaveBeenCalled();
        workspaceStatus = "ready";
        workspacePresence = "present";
        ready.resolve({
            id: "workspace-1",
            name: "Setup",
            path: "/workspaces/setup",
            presence: "present",
            projectId: "project-1",
            status: "ready",
        } as ProjectWorkspace);
        await expect(spawned).resolves.toMatchObject({ status: "running" });
        expect(createSubagent).toHaveBeenCalledTimes(1);

        workspaceStatus = "ready";
        workspacePresence = "missing";
        await expect(manager.spawnInWorkspace(parent.id, request)).rejects.toThrow(
            "directory is unavailable",
        );
        expect(createSubagent).toHaveBeenCalledTimes(1);
    });

    describe("subagent model policy", () => {
        function pinnedManagerFixture(policy?: SubagentModelPolicy) {
            const providerModels = new Map([
                ["codex", new Set(["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"])],
            ]);
            const effortLevels = new Map([
                ["openai/gpt-5.6-sol", ["low", "medium", "high"]],
                ["openai/gpt-5.6-luna", ["low", "medium", "max"]],
            ]);
            const child = {
                agentMetadata: () => ({
                    depth: 1,
                    parentSessionId: "root-1",
                    rootSessionId: "root-1",
                    taskName: "pinned",
                    type: "subagent" as const,
                }),
                id: "child-1",
                isSubagent: () => true,
                subagentSummary: () => ({ status: "running" }),
                submit: vi.fn(() => ({ runId: "child-run" })),
            } as unknown as InMemorySession;
            const parent = {
                agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" }),
                effortLevelsForModel: (modelId: string) => effortLevels.get(modelId),
                hasModel: (modelId: string, providerId?: string) =>
                    providerId === undefined
                        ? [...providerModels.values()].some((models) => models.has(modelId))
                        : (providerModels.get(providerId)?.has(modelId) ?? false),
                id: "root-1",
                isSubagent: () => false,
                providerIdsForModel: (modelId: string) =>
                    [...providerModels.entries()]
                        .filter(([, models]) => models.has(modelId))
                        .map(([providerId]) => providerId),
                recordSubagentChanged: vi.fn(),
                requestForSubagent: () => ({
                    cwd: "/tmp/rig-policy-test",
                    modelId: "openai/gpt-5.6-sol",
                    permissionMode: "auto",
                    providerId: "codex",
                }),
            } as unknown as InMemorySession;
            const requests: CreateSessionRequest[] = [];
            const createSubagent = vi.fn((request: CreateSessionRequest) => {
                requests.push(request);
                return child;
            });
            const manager = new AgentSessionManager({
                repository: {
                    createSubagent,
                    get: (sessionId) => (sessionId === parent.id ? parent : undefined),
                    listByRoot: () => [],
                },
                ...(policy === undefined ? {} : { subagentModelPolicy: policy }),
            });
            return { createSubagent, manager, parent, requests };
        }

        it("overrides the model and effort the orchestrator asked for", async () => {
            const { createSubagent, manager, parent } = pinnedManagerFixture({
                effort: "max",
                modelId: "openai/gpt-5.6-luna",
            });

            await manager.spawn(parent.id, {
                background: true,
                description: "Pinned child",
                effort: "high",
                modelId: "openai/gpt-5.6-sol",
                prompt: "The orchestrator picked sol; the policy pins luna.",
            });

            expect(createSubagent).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    effort: "max",
                    modelId: "openai/gpt-5.6-luna",
                    providerId: "codex",
                }),
                expect.anything(),
            );
        });

        it("clears an unpinned effort when the pinned model differs", async () => {
            // "high" is a sol level and not a luna one, so carrying it across
            // would fail validation against the model the child actually runs.
            const { createSubagent, manager, parent, requests } = pinnedManagerFixture({
                modelId: "openai/gpt-5.6-luna",
            });

            await manager.spawn(parent.id, {
                background: true,
                description: "Pinned model only",
                effort: "high",
                modelId: "openai/gpt-5.6-sol",
                prompt: "Effort must not survive the model swap.",
            });

            expect(createSubagent).toHaveBeenLastCalledWith(
                expect.objectContaining({ modelId: "openai/gpt-5.6-luna" }),
                expect.anything(),
            );
            expect(requests.at(-1)?.effort).toBeUndefined();
        });

        it("leaves the orchestrator's choice alone when no policy is set", async () => {
            const { createSubagent, manager, parent } = pinnedManagerFixture();

            await manager.spawn(parent.id, {
                background: true,
                description: "Unpinned child",
                effort: "high",
                modelId: "openai/gpt-5.6-sol",
                prompt: "Nothing is pinned, so nothing changes.",
            });

            expect(createSubagent).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    effort: "high",
                    modelId: "openai/gpt-5.6-sol",
                }),
                expect.anything(),
            );
        });
    });
});

describe("subagentModelPolicyFromEnvironment", () => {
    it("is undefined when nothing is set, so the policy stays off by default", () => {
        expect(subagentModelPolicyFromEnvironment({})).toBeUndefined();
        expect(
            subagentModelPolicyFromEnvironment({
                RIG_SUBAGENT_EFFORT: "  ",
                RIG_SUBAGENT_MODEL: "",
            }),
        ).toBeUndefined();
    });

    it("reads a maximum subagent depth, treating zero as a real value", () => {
        expect(subagentMaxDepthFromEnvironment({})).toBeUndefined();
        expect(subagentMaxDepthFromEnvironment({ RIG_SUBAGENT_MAX_DEPTH: "0" })).toBe(0);
        expect(subagentMaxDepthFromEnvironment({ RIG_SUBAGENT_MAX_DEPTH: "2" })).toBe(2);
        // Garbage falls back to the default rather than silently disabling
        // delegation, which would be the worst possible way to misread it.
        expect(subagentMaxDepthFromEnvironment({ RIG_SUBAGENT_MAX_DEPTH: "-1" })).toBeUndefined();
        expect(subagentMaxDepthFromEnvironment({ RIG_SUBAGENT_MAX_DEPTH: "no" })).toBeUndefined();
    });

    it("reads model, effort and provider", () => {
        expect(
            subagentModelPolicyFromEnvironment({
                RIG_SUBAGENT_EFFORT: "max",
                RIG_SUBAGENT_MODEL: "openai/gpt-5.6-luna",
                RIG_SUBAGENT_PROVIDER: "codex",
            }),
        ).toEqual({
            effort: "max",
            modelId: "openai/gpt-5.6-luna",
            providerId: "codex",
        });
    });
});

function delegatorSession(overrides: Partial<InMemorySession> = {}): InMemorySession {
    return {
        agentMetadata: () => ({ depth: 0, rootSessionId: "root-1", type: "primary" as const }),
        deliverNotification: vi.fn(),
        id: "root-1",
        isClosing: () => false,
        isSubagent: () => false,
        requestForSubagent: () => ({
            cwd: "/project",
            modelId: "openai/gpt-5.6-sol",
            permissionMode: "auto",
            providerId: "codex",
            trackUnread: false,
        }),
        snapshot: () => ({ projectId: "project-1" }),
        ...overrides,
    } as unknown as InMemorySession;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function historySession(options: {
    id: string;
    messages: readonly string[];
    metadata: SessionAgentMetadata;
}): InMemorySession {
    return {
        agentIdentity: () => ({ agentId: `agent-${options.id}`, folder: options.id }),
        agentMetadata: () => options.metadata,
        id: options.id,
        isSubagent: () => options.metadata.type === "subagent",
        snapshot: () => ({
            agent: options.metadata,
            snapshot: {
                messages: options.messages.map((text, index) => ({
                    blocks: [{ text, type: "text" as const }],
                    id: `${options.id}-${index}`,
                    role: "user" as const,
                })),
            },
            status: "idle",
        }),
    } as unknown as InMemorySession;
}

function historyMessageSession(options: {
    id: string;
    messages: readonly import("../../agent/types.js").Message[];
    metadata: SessionAgentMetadata;
}): InMemorySession {
    return {
        agentIdentity: () => ({ agentId: `agent-${options.id}`, folder: options.id }),
        agentMetadata: () => options.metadata,
        id: options.id,
        isSubagent: () => options.metadata.type === "subagent",
        snapshot: () => ({
            agent: options.metadata,
            snapshot: { messages: options.messages },
            status: "idle",
        }),
    } as unknown as InMemorySession;
}
