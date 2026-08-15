import { createTestRootContext } from "../testing/createTestRootContext.js";
import { describe, expect, it } from "vitest";
import type { Executor } from "@slopus/rig-execution";

import { createNodeAgentContext, type PermissionMode } from "../agent/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createExecutor } from "./createExecutor.js";

function testExecutor(permissionMode: PermissionMode): Executor {
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: "/tmp/rig-executor-server-tools",
        permissionMode,
        processManager: new NativeProcessManager(),
    });
    const result = createExecutor({
        agentContext: context,
        apiKey: "test-api-key",
        env: { XAI_API_KEY: "test-api-key" },
        providers: {
            claude: { enabled: true, type: "claude" },
            codex: { enabled: true, type: "codex" },
            grok: { enabled: true, type: "grok" },
        },
        sessionId: "session-1",
    });
    const executor = result.executor;
    if (executor === undefined) throw new Error("The executor was not built.");
    return executor;
}

describe("createExecutor", () => {
    it("creates one executor containing every enabled configured provider", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext(createTestRootContext().named("agent"), {
                cwd: "/tmp/rig-executor-test",
                processManager: new NativeProcessManager(),
            }),
            apiKey: "test-api-key",
            env: {},
            providers: {
                codex: { enabled: true, type: "codex" },
                disabled_claude: { enabled: false, type: "claude" },
                grok: { enabled: true, type: "grok" },
            },
            sessionId: "session-1",
        });

        expect(result.executor?.providers.map((provider) => provider.id)).toEqual([
            "codex",
            "grok",
        ]);
        expect(result.missingCredentials).toEqual(new Map());
        expect(result.executor?.profiles.map((profile) => profile.id)).toEqual(
            expect.arrayContaining(["openai/gpt-5.6-sol", "xai/grok-build"]),
        );
        expect(result.executor?.environment).toMatchObject({
            osVersion: expect.any(String),
            platform: process.platform,
            primaryWorkingDirectory: "/tmp/rig-executor-test",
            shell: "",
        });

        result.executor?.selectProvider("grok");
        expect(result.executor?.id).toBe("grok");
        expect(result.executor?.models.map((model) => model.id)).toContain("xai/grok-build");
    });

    it("authenticates Bedrock from the configuration file without any environment variable", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext(createTestRootContext().named("agent"), {
                cwd: "/tmp/rig-executor-bedrock-token",
                processManager: new NativeProcessManager(),
            }),
            env: {},
            providers: {
                bedrock: {
                    bearerToken: "token-from-configuration",
                    enabled: true,
                    region: "us-east-1",
                    type: "bedrock",
                },
            },
            sessionId: "session-1",
        });

        expect(result.missingCredentials).toEqual(new Map());
        expect(result.executor?.providers.map((provider) => provider.id)).toEqual(["bedrock"]);
    });
});
