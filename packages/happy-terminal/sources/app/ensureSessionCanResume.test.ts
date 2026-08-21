import { describe, expect, it } from "vitest";

import type { ProtocolSession } from "../protocol/index.js";
import { ensureSessionCanResume } from "./ensureSessionCanResume.js";

describe("ensureSessionCanResume", () => {
    it("rejects attempts to resume a subagent history", () => {
        expect(() => ensureSessionCanResume(subagentSession())).toThrow(
            "Subagent histories are read-only",
        );
    });
});

function subagentSession(): ProtocolSession {
    return {
        activity: { kind: "idle", label: "Idle", since: 0 },
        agent: {
            depth: 1,
            description: "Inspect the code",
            parentSessionId: "session-1",
            rootSessionId: "session-1",
            type: "subagent",
        },
        agentId: "agent-2",
        ownerInstanceId: "alocalinstance00000000001",
        archived: false,
        cwd: "/tmp/happy-terminal-resume-test",
        id: "subagent-1",
        projectId: "project-1",
        scope: { kind: "project", projectId: "project-1" },
        orderKey: "a0",
        modelId: "openai/gpt-5.5",
        modelLocked: true,
        modelCatalog: {
            defaultModelId: "openai/gpt-5.5",
            defaultProviderId: "codex",
            models: [],
            providers: [],
        },
        models: [],
        providerId: "codex",
        permissionMode: "workspace_write",
        mcpServers: [],
        pendingUserInputs: [],
        projectSecretIds: [],
        secretIds: [],
        sessionSecretIds: [],
        tasks: [],
        snapshot: {
            id: "agent-2",
            messages: [],
            modelId: "openai/gpt-5.5",
            providerId: "codex",
            queue: [],
            status: "idle",
            tools: [],
        },
        status: "completed",
        titleStatus: "ready",
    };
}
