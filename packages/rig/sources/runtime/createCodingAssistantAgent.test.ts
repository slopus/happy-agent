import { describe, expect, it } from "vitest";

import {
    modelAnthropicFable5,
    modelAnthropicOpus5,
    modelAnthropicSonnet5,
    modelOpenaiGpt56Sol,
    modelXaiGrokBuild,
} from "@slopus/rig-execution";

import { NativeProcessManager } from "../processes/index.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";
import { createCodingAssistantAgent } from "./createCodingAssistantAgent.js";

describe("createCodingAssistantAgent", () => {
    it("creates a Codex runtime without legacy model tools", () => {
        const cwd = "/tmp/rig-app-test";
        const processManager = new NativeProcessManager();
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd,
            env: { GEMINI_API_KEY: "unused-by-legacy-tools" },
            effort: "medium",
            processManager,
        });

        expect(runtime.cwd).toBe(cwd);
        expect(runtime.processManager).toBe(processManager);
        expect(runtime.executor.id).toBe("codex");
        expect(runtime.agent.model.id).toBe(modelOpenaiGpt56Sol.id);
        expect(runtime.context.fs.cwd).toBe(cwd);
        expect(runtime.context.bash.cwd).toBe(cwd);
        expect(runtime.agent.snapshot().instructions).toContain(cwd);
        expect(runtime.agent.snapshot().effort).toBe("medium");
        expect(runtime.agent.tools).toEqual([]);
    });

    it("keeps optional host contexts without exposing their legacy tools", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            goals: {
                create: async () => {
                    throw new Error("unused");
                },
                get: () => undefined,
                update: async () => {
                    throw new Error("unused");
                },
            },
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: async () => {
                    throw new Error("unused");
                },
                interrupt: async () => {
                    throw new Error("unused");
                },
                list: () => [],
                maxDepth: 3,
                spawn: async () => {
                    throw new Error("unused");
                },
                wait: async () => ({ agents: [], timedOut: false }),
            },
        });

        expect(runtime.context.goals).toBeDefined();
        expect(runtime.context.subagents).toBeDefined();
        expect(runtime.agent.tools).toEqual([]);
    });

    it("creates Claude and Grok runtimes without vendor tool surfaces", () => {
        const claude = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelAnthropicFable5.id,
        });
        const grok = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrokBuild.id,
        });

        expect(claude.executor.id).toBe("claude");
        expect(claude.executor.reviewerModelFor?.(modelAnthropicFable5)).toEqual(
            modelAnthropicSonnet5,
        );
        expect(claude.executor.reviewerModelFor?.(modelAnthropicOpus5)).toEqual(
            modelAnthropicSonnet5,
        );
        expect(claude.agent.tools).toEqual([]);
        expect(grok.executor.id).toBe("grok");
        expect(grok.agent.tools).toEqual([]);
    });

    it("creates agents for named provider instances and applies model filters", () => {
        const providers = {
            work_codex: {
                authFile: "/tmp/codex-work-auth.json",
                enabled: true,
                includeModels: [modelOpenaiGpt56Sol.id],
                type: "codex" as const,
            },
            work_claude: {
                configDir: "/tmp/claude-work",
                enabled: true,
                includeModels: [modelAnthropicFable5.id],
                type: "claude" as const,
            },
        };
        const codex = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "work_codex",
            providers,
        });
        const claude = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
            providerId: "work_claude",
            providers,
        });

        expect(codex.executor.models).toEqual([modelOpenaiGpt56Sol]);
        expect(claude.executor.models).toEqual([modelAnthropicFable5]);
        expect(codex.agent.tools).toEqual([]);
        expect(claude.agent.tools).toEqual([]);
    });

    it("rejects disabled provider instances", () => {
        expect(() =>
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                providerId: "codex",
                providers: {
                    codex: { enabled: false, type: "codex" },
                },
            }),
        ).toThrow("Unknown or disabled inference provider 'codex'.");
    });
});
