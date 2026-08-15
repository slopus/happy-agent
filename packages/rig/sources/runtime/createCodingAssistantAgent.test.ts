import { createTestRootContext } from "../testing/createTestRootContext.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { NativeProcessManager } from "../processes/index.js";
import {
    modelAnthropicFable5,
    modelAnthropicOpus5,
    modelAnthropicSonnet5,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelXaiGrok45,
    modelXaiGrokBuild,
} from "@slopus/rig-execution";
import { createSystemPrompt } from "../agent/prompt/createSystemPrompt.js";
import { toExecutorTool } from "../agent/tools/toExecutorTool.js";
import { createCodingAssistantAgent } from "./createCodingAssistantAgent.js";

const ctx = createTestRootContext();

describe("createCodingAssistantAgent", () => {
    it("creates a Codex agent with node filesystem and bash contexts", () => {
        const cwd = "/tmp/rig-app-test";
        const processManager = new NativeProcessManager();

        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd,
            env: {},
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
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "agent_me",
                "agent_info",
                "agent_send",
                "codex_imagegen",
                "get_agent_tree_usage",
            ]),
        );
    });

    it("automatically enables universal Gemini tools from the daemon environment", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { GEMINI_API_KEY: "gemini-key" },
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "gemini_web_search",
                "gemini_generate_image",
                "gemini_generate_music",
                "gemini_analyze_media",
            ]),
        );
    });

    it("allows same-project delegation without cross-workspace access", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            workspaces: {
                addProject: async () => {
                    throw new Error("unused");
                },
                archive: async () => {
                    throw new Error("unused");
                },
                create: async () => {
                    throw new Error("unused");
                },
                crossWorkspace: false,
                delegate: async () => {
                    throw new Error("unused");
                },
                listProjects: async () => [],
                listSessions: async () => [],
                listWorkspaces: async () => [],
                spawn: async () => {
                    throw new Error("unused");
                },
                transfer: async () => {
                    throw new Error("unused");
                },
            },
        });
        const names = runtime.agent.tools.map((tool) => tool.name);

        expect(names).toContain("delegate_to_workspace");
        expect(names).not.toContain("list_projects");
    });

    it("gives the Auto permission reviewer read-only tools and its own permissions", async () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            agentId: "agent-session",
            cwd: "/tmp/rig-app-test",
            env: {},
            permissionMode: "auto",
        });

        const reviewerTools = runtime.agent.tools.filter(
            (tool) => tool.availableToPermissionReviewer,
        );
        expect(reviewerTools.map((tool) => tool.name)).toEqual([]);

        await runtime.agent.close();
    });

    it("creates a Claude SDK agent for Anthropic models", () => {
        const cwd = "/tmp/rig-app-test";
        const processManager = new NativeProcessManager();

        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd,
            env: {},
            modelId: modelAnthropicFable5.id,
            processManager,
        });

        expect(runtime.executor.id).toBe("claude");
        expect(runtime.agent.model.id).toBe(modelAnthropicFable5.id);
        expect(runtime.executor.reviewerModelFor?.(modelAnthropicFable5)).toEqual(
            modelAnthropicSonnet5,
        );
        expect(runtime.executor.reviewerModelFor?.(modelAnthropicOpus5)).toEqual(
            modelAnthropicSonnet5,
        );
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual([
            "TaskOutput",
            "TaskCreate",
            "TaskGet",
            "TaskUpdate",
            "TaskList",
            "TaskStop",
            "TaskInput",
            "AskUserQuestion",
            "imagegen",
            "web_fetch",
            "claude_web_search",
            "codex_web_search",
            "grok_web_search",
            "grok_x_search",
            "attach",
            "request_secret",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "applet_create",
            "applet_update",
            "applet_revert",
            "applet_list",
            "worklet_install",
            "worklet_update",
            "worklet_revert",
            "worklet_uninstall",
            "worklet_list",
            "worklet_logs",
            "agent_me",
            "agent_info",
            "agent_send",
        ]);
    });

    it.each([
        ["Codex v2", modelOpenaiGpt56Sol.id, {}],
        ["Codex v1", modelOpenaiGpt56Luna.id, {}],
        ["Claude", modelAnthropicFable5.id, {}],
        ["Grok", modelXaiGrokBuild.id, { XAI_API_KEY: "xai-test-key" }],
    ])("gives every %s tool a provider-compatible input schema", (_name, modelId, env) => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            chatHistory: {
                read: () => {
                    throw new Error("unused");
                },
            },
            cwd: "/tmp/rig-tool-schema-test",
            env: { ...env, GEMINI_API_KEY: "gemini-key" },
            goals: {
                create: () => {
                    throw new Error("unused");
                },
                get: () => undefined,
                update: () => {
                    throw new Error("unused");
                },
            },
            modelId,
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => {
                    throw new Error("unused");
                },
                interrupt: () => {
                    throw new Error("unused");
                },
                list: () => [],
                maxDepth: 2,
                spawn: async () => {
                    throw new Error("unused");
                },
                wait: async () => ({ agents: [], timedOut: true }),
            },
            workflows: {
                get: () => undefined,
                launch: () => {
                    throw new Error("unused");
                },
                stop: () => undefined,
                wait: async () => undefined,
            },
            workspaces: {
                addProject: async () => {
                    throw new Error("unused");
                },
                archive: async () => {
                    throw new Error("unused");
                },
                create: async () => {
                    throw new Error("unused");
                },
                crossWorkspace: true,
                delegate: async () => {
                    throw new Error("unused");
                },
                listProjects: async () => [],
                listSessions: async () => [],
                listWorkspaces: async () => [],
                spawn: async () => {
                    throw new Error("unused");
                },
                transfer: async () => {
                    throw new Error("unused");
                },
            },
        });
        const providerInputSchema = Type.Object(
            { type: Type.Literal("object") },
            { additionalProperties: true },
        );
        const invalidTools = runtime.agent.tools.flatMap((tool) => {
            const definition = toExecutorTool(tool);
            if (definition.kind === "custom") return [];
            return Value.Check(providerInputSchema, definition.parameters) ? [] : [definition.name];
        });

        expect(invalidTools).toEqual([]);
    });

    it("creates a Claude SDK agent for Opus 5", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelAnthropicOpus5.id,
        });

        expect(runtime.executor.id).toBe("claude");
        expect(runtime.agent.model).toEqual(modelAnthropicOpus5);
    });

    it("keeps image generation out of the reserved Responses image tool and namespace", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelOpenaiGpt56Sol.id,
        });

        const names = runtime.agent.tools.map((tool) => tool.name);
        expect(names).toContain("codex_imagegen");
        expect(names).not.toContain("imagegen");
        const imagegen = runtime.agent.tools.find((tool) => tool.name === "codex_imagegen");
        expect(toExecutorTool(imagegen!)).not.toHaveProperty("namespace");
    });

    it("omits image generation when no Codex cloud provider is configured", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelAnthropicFable5.id,
            providers: {
                claude: { enabled: true, type: "claude" },
            },
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).not.toContain("imagegen");
    });

    it("creates a Grok Build agent with the native Grok tool surface", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrokBuild.id,
        });

        expect(runtime.executor.id).toBe("grok");
        expect(runtime.agent.model).toEqual(modelXaiGrokBuild);
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual([
            "get_subagent_output",
            "kill_subagent",
            "imagegen",
            "web_fetch",
            "claude_web_search",
            "codex_web_search",
            "grok_web_search",
            "grok_x_search",
            "attach",
            "request_secret",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "applet_create",
            "applet_update",
            "applet_revert",
            "applet_list",
            "worklet_install",
            "worklet_update",
            "worklet_revert",
            "worklet_uninstall",
            "worklet_list",
            "worklet_logs",
            "agent_me",
            "agent_info",
            "agent_send",
        ]);
    });

    it("creates a Grok agent for a curated model", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrok45.id,
        });

        expect(runtime.executor.id).toBe("grok");
        expect(runtime.agent.model).toEqual(modelXaiGrok45);
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("get_subagent_output");
    });

    it("creates agents for named provider instances and applies their model filters", () => {
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

        expect(codex.executor.id).toBe("work_codex");
        expect(codex.executor.models).toEqual([modelOpenaiGpt56Sol]);
        expect(claude.executor.id).toBe("work_claude");
        expect(claude.executor.models).toEqual([modelAnthropicFable5]);
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

    it("rejects an explicitly selected provider whose filters remove every model", () => {
        expect(() =>
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                modelId: modelOpenaiGpt56Sol.id,
                providerId: "work_codex",
                providers: {
                    work_codex: {
                        enabled: true,
                        excludeModels: [modelOpenaiGpt56Sol.id],
                        includeModels: [modelOpenaiGpt56Sol.id],
                        type: "codex",
                    },
                },
            }),
        ).toThrow("Provider 'work_codex' has no models after applying its model filters.");
    });

    it("does not fall back to the default Bedrock credential for a named instance", () => {
        expect(() =>
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                env: { AWS_BEARER_TOKEN_BEDROCK: "default-token" },
                modelId: modelOpenaiGpt56Sol.id,
                providerId: "work_bedrock",
                providers: {
                    work_bedrock: {
                        bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                        enabled: true,
                        type: "bedrock",
                    },
                },
            }),
        ).toThrow(
            "Inference provider 'work_bedrock' requires the WORK_BEDROCK_TOKEN environment variable.",
        );
    });

    it("applies a Bedrock model-specific region override", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { WORK_BEDROCK_TOKEN: "work-token" },
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "work_bedrock",
            providers: {
                work_bedrock: {
                    bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                    enabled: true,
                    modelOverrides: {
                        [modelOpenaiGpt56Sol.id]: { region: "us-east-1" },
                    },
                    region: "us-west-2",
                    type: "bedrock",
                },
            },
        });

        expect(runtime.executor.models.map((model) => model.id)).toContain(modelOpenaiGpt56Sol.id);
    });

    it("allows a Bedrock endpoint override to bypass regional availability", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { WORK_BEDROCK_TOKEN: "work-token" },
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "work_bedrock",
            providers: {
                work_bedrock: {
                    bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                    enabled: true,
                    modelOverrides: {
                        [modelOpenaiGpt56Sol.id]: {
                            endpoint: "https://mantle.example/openai/v1",
                        },
                    },
                    region: "us-west-2",
                    type: "bedrock",
                },
            },
        });

        expect(runtime.executor.models.map((model) => model.id)).toContain(modelOpenaiGpt56Sol.id);
    });

    it("adds provider-neutral goal tools when the session supports goals", () => {
        const currentGoal = {
            createdAt: 1,
            objective: "Finish the feature",
            status: "active" as const,
            updatedAt: 1,
        };
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            goals: {
                create: async () => currentGoal,
                get: () => currentGoal,
                update: async (status) => ({ ...currentGoal, status }),
            },
            modelId: modelAnthropicFable5.id,
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["create_goal", "get_goal", "update_goal"]),
        );
    });

    it("assembles a flat Codex tool list", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => {
                    throw new Error("not used");
                },
                interrupt: () => {
                    throw new Error("not used");
                },
                list: () => [],
                maxDepth: 3,
                spawn: async () => {
                    throw new Error("not used");
                },
                wait: async () => ({ agents: [], timedOut: false }),
            },
            workflows: {
                get: () => undefined,
                launch: () => {
                    throw new Error("not used");
                },
                stop: () => undefined,
                wait: async () => undefined,
            },
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "workflow",
                "wait_for_workflow",
                "workflow_status",
                "stop_workflow",
                "spawn_agent",
                "followup_task",
                "send_message",
                "wait_agent",
                "list_agents",
                "interrupt_agent",
            ]),
        );
        expect(
            runtime.agent.tools
                .filter((tool) => tool.namespace?.name === "collaboration")
                .map((tool) => tool.name),
        ).toEqual([
            "spawn_agent",
            "followup_task",
            "send_message",
            "wait_agent",
            "list_agents",
            "interrupt_agent",
        ]);
        expect(
            runtime.agent.tools
                .filter((tool) => tool.namespace?.name === "collaboration_ext")
                .map((tool) => tool.name),
        ).toEqual(["spawn_agent", "followup_task"]);
    });

    it("defers long-tail tools and keeps surviving native tools eager", () => {
        const codex = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
        });
        const claude = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
        });
        const byName = (runtime: typeof codex, name: string) =>
            runtime.agent.tools.find((tool) => tool.name === name);

        expect(byName(codex, "update_plan")?.deferLoading).toBeUndefined();
        expect(byName(codex, "exec_command")).toBeUndefined();
        expect(byName(codex, "apply_patch")).toBeUndefined();
        expect(byName(codex, "attach")?.deferLoading).toBe(true);
        expect(byName(codex, "plugin_discover")?.deferLoading).toBe(true);
        expect(byName(codex, "agent_me")?.deferLoading).toBe(true);
        expect(byName(codex, "codex_imagegen")?.deferLoading).toBe(true);

        expect(byName(claude, "Bash")).toBeUndefined();
        expect(byName(claude, "Read")).toBeUndefined();
        expect(byName(claude, "TaskList")?.deferLoading).toBe(true);
        expect(byName(claude, "attach")?.deferLoading).toBe(true);
    });

    it("exposes the Agent tool only while another nested level is available", () => {
        const spawn = async () => ({
            agentId: "test-agent",
            output: "done",
            path: "/root/test",
            sessionId: "subagent-1",
            status: "completed" as const,
            taskName: "test",
        });
        const controls = {
            depth: 0,
            followUp: () => {
                throw new Error("not used");
            },
            interrupt: () => {
                throw new Error("not used");
            },
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };
        const workflows = {
            get: () => undefined,
            launch: () => {
                throw new Error("not used");
            },
            stop: () => undefined,
            wait: async () => undefined,
        };
        const parent = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            subagents: { ...controls, canSpawn: true },
            workflows,
        });
        const deepest = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            subagents: { ...controls, canSpawn: false, depth: 3 },
        });

        expect(parent.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "update_plan",
                "request_user_input",
                "workflow",
                "spawn_agent",
            ]),
        );
        expect(deepest.agent.tools.map((tool) => tool.name)).not.toContain("spawn_agent");
        expect(deepest.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "followup_task",
                "wait_agent",
                "list_agents",
                "interrupt_agent",
                "send_message",
            ]),
        );
        expect(deepest.agent.tools.map((tool) => tool.name)).not.toContain("workflow");

        const claudeParent = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
            subagents: { ...controls, canSpawn: true },
            workflows,
        });
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("Agent");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("SendMessage");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("Workflow");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("WaitForWorkflow");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).not.toContain("spawn_agent");

        const claudeDeepest = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
            subagents: { ...controls, canSpawn: false, depth: 3 },
            workflows,
        });
        expect(claudeDeepest.agent.tools.map((tool) => tool.name)).toContain("SendMessage");
        expect(claudeDeepest.agent.tools.map((tool) => tool.name)).not.toContain("Agent");
        expect(claudeDeepest.agent.tools.map((tool) => tool.name)).not.toContain("Workflow");

        const grokParent = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrok45.id,
            subagents: { ...controls, canSpawn: true },
        });
        expect(grokParent.agent.tools.map((tool) => tool.name)).toContain("spawn_subagent");
        expect(grokParent.agent.tools.map((tool) => tool.name)).toContain("followup_subagent");

        const grokDeepest = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrok45.id,
            subagents: { ...controls, canSpawn: false, depth: 3 },
        });
        expect(grokDeepest.agent.tools.map((tool) => tool.name)).toContain("followup_subagent");
        expect(grokDeepest.agent.tools.map((tool) => tool.name)).not.toContain("spawn_subagent");
    });

    it("does not add a separate parent delegation prompt for any provider", async () => {
        const controls = {
            canSpawn: true,
            depth: 0,
            followUp: () => {
                throw new Error("not used");
            },
            interrupt: () => {
                throw new Error("not used");
            },
            list: () => [],
            maxDepth: 3,
            spawn: async () => {
                throw new Error("not used");
            },
            wait: async () => ({ agents: [], timedOut: false }),
        };
        const runtimes = [
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                modelId: modelOpenaiGpt56Sol.id,
                subagents: controls,
            }),
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                modelId: modelAnthropicFable5.id,
                subagents: controls,
            }),
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                env: { XAI_API_KEY: "xai-test-key" },
                modelId: modelXaiGrok45.id,
                subagents: controls,
            }),
        ];

        for (const runtime of runtimes) {
            const prompt = await createSystemPrompt(ctx, {
                context: runtime.context,
                messages: [],
                model: runtime.agent.model,
                provider: runtime.executor,
                tools: runtime.agent.tools,
            });

            expect(prompt).not.toContain("# Delegation role");
            expect(prompt).not.toContain("You are the parent agent");
            if (runtime.executor.type === "codex") {
                expect(prompt).toContain(
                    "`collaboration.wait_agent` is also steerable, even though the canonical tool description does not say so",
                );
            } else {
                expect(prompt).not.toContain("`collaboration.wait_agent` is also steerable");
            }
        }
    });

    it("explains incoming steering whenever steerable tools are available", async () => {
        const runtimes = [
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                modelId: modelOpenaiGpt56Sol.id,
            }),
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                modelId: modelAnthropicFable5.id,
            }),
            createCodingAssistantAgent({
                ctx: createTestRootContext().named("agent"),
                cwd: "/tmp/rig-app-test",
                env: { XAI_API_KEY: "xai-test-key" },
                modelId: modelXaiGrok45.id,
            }),
        ];

        for (const runtime of runtimes) {
            const prompt = await createSystemPrompt(ctx, {
                context: runtime.context,
                messages: [],
                model: runtime.agent.model,
                provider: runtime.executor,
                tools: runtime.agent.tools,
            });

            expect(prompt).toContain("Tools described as steerable are interrupted");
            expect(prompt).toContain("new user messages");
            expect(prompt).toContain("messages from other agents");
            expect(prompt).toContain("background completion notifications");
        }

        const runtime = runtimes[0]!;
        const promptWithoutSteerableTools = await createSystemPrompt(ctx, {
            context: runtime.context,
            messages: [],
            model: runtime.agent.model,
            provider: runtime.executor,
            tools: runtime.agent.tools.filter((tool) => !tool.steerable),
        });

        expect(promptWithoutSteerableTools).not.toContain(
            "Tools described as steerable are interrupted",
        );
    });

    it("explains workspace isolation only when workspace tools are present", async () => {
        const workspaces = {
            addProject: async () => {
                throw new Error("unused");
            },
            archive: async () => {
                throw new Error("unused");
            },
            create: async () => {
                throw new Error("unused");
            },
            crossWorkspace: false,
            delegate: async () => {
                throw new Error("unused");
            },
            listProjects: async () => [],
            listSessions: async () => [],
            listWorkspaces: async () => [],
            spawn: async () => {
                throw new Error("unused");
            },
            transfer: async () => {
                throw new Error("unused");
            },
        };
        const withWorkspaces = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
            workspaces,
        });
        const withoutWorkspaces = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {},
        });

        const promptWith = await createSystemPrompt(ctx, {
            context: withWorkspaces.context,
            messages: [],
            model: withWorkspaces.agent.model,
            provider: withWorkspaces.executor,
            tools: withWorkspaces.agent.tools,
        });
        const promptWithout = await createSystemPrompt(ctx, {
            context: withoutWorkspaces.context,
            messages: [],
            model: withoutWorkspaces.agent.model,
            provider: withoutWorkspaces.executor,
            tools: withoutWorkspaces.agent.tools,
        });

        expect(promptWith).toContain("# Workspaces");
        expect(promptWith).toContain("parallel tasks each get their own fresh workspace");
        expect(promptWithout).not.toContain("# Workspaces");
    });

    it("keeps V2 child guidance at maximum depth and excludes Luna", async () => {
        const managed = {
            agentId: "test-agent",
            description: "Test",
            path: "/root/test",
            sessionId: "test",
            status: "completed" as const,
            taskName: "test",
        };
        const controls = {
            depth: 3,
            followUp: async () => managed,
            interrupt: async () => managed,
            list: () => [managed],
            maxActive: 4,
            maxDepth: 3,
            sendMessage: () => managed,
            spawn: async () => ({ ...managed, output: "done" }),
            wait: async () => ({ agents: [managed], timedOut: false }),
        };
        const deepest = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
            subagents: { ...controls, canSpawn: false },
        });
        const luna = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Luna.id,
            subagents: { ...controls, canSpawn: true, depth: 0 },
        });

        const deepestPrompt = await createSystemPrompt(ctx, {
            context: deepest.context,
            messages: [],
            model: deepest.agent.model,
            provider: deepest.executor,
            tools: deepest.agent.tools,
        });
        const lunaPrompt = await createSystemPrompt(ctx, {
            context: luna.context,
            messages: [],
            model: luna.agent.model,
            provider: luna.executor,
            tools: luna.agent.tools,
        });

        expect(deepestPrompt).toContain("immediately delivered back to your parent agent");
        expect(deepestPrompt).toContain("cannot spawn additional sub-agents at this depth");
        expect(deepestPrompt).not.toContain("`spawn_agent`");
        expect(lunaPrompt).not.toContain("immediately delivered back to your parent agent");
        expect(luna.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["close_agent", "resume_agent", "send_input"]),
        );
        expect(luna.agent.tools.map((tool) => tool.name)).not.toContain("followup_task");
    });

    it("omits workflow tools when workflow support is disabled", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => {
                    throw new Error("not used");
                },
                interrupt: () => {
                    throw new Error("not used");
                },
                list: () => [],
                maxDepth: 3,
                spawn: async () => {
                    throw new Error("not used");
                },
                wait: async () => ({ agents: [], timedOut: false }),
            },
            workflows: {
                get: () => undefined,
                launch: () => {
                    throw new Error("not used");
                },
                stop: () => undefined,
                wait: async () => undefined,
            },
            workflowsEnabled: false,
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).not.toEqual(
            expect.arrayContaining([
                "workflow",
                "wait_for_workflow",
                "workflow_status",
                "stop_workflow",
            ]),
        );
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("spawn_agent");
    });

    it("creates an Amazon Bedrock agent for Bedrock Anthropic models", () => {
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
            modelId: modelAnthropicFable5.id,
            providerId: "bedrock",
        });

        expect(runtime.executor.id).toBe("bedrock");
        expect(runtime.agent.model.id).toBe(modelAnthropicFable5.id);
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("TaskOutput");
        expect(runtime.agent.tools.map((tool) => tool.name)).not.toContain("Bash");
        // Bedrock's hosted search is an ordinary tool, so an Anthropic model reaches it too even
        // though its own transport has no search of its own.
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("bedrock_web_search");
    });

    it("uses plaintext multi-agent v1 tools for Bedrock OpenAI models", () => {
        const managed = {
            agentId: "test-agent",
            description: "Test",
            path: "/root/test",
            sessionId: "test",
            status: "completed" as const,
            taskName: "test",
        };
        const runtime = createCodingAssistantAgent({
            ctx: createTestRootContext().named("agent"),
            cwd: "/tmp/rig-app-test",
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "bedrock",
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: async () => managed,
                interrupt: async () => managed,
                list: () => [managed],
                maxDepth: 3,
                spawn: async () => ({ ...managed, output: "done" }),
                wait: async () => ({ agents: [managed], timedOut: false }),
            },
        });

        expect(runtime.executor.id).toBe("bedrock");
        expect(runtime.agent.model.id).toBe(modelOpenaiGpt56Sol.id);
        expect(
            runtime.agent.tools
                .filter((tool) => tool.namespace?.name === "multi_agent_v1")
                .map((tool) => tool.name),
        ).toEqual(["close_agent", "resume_agent", "send_input", "spawn_agent", "wait_agent"]);
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual([
            "update_plan",
            "request_user_input",
            "codex_imagegen",
            "web_fetch",
            "claude_web_search",
            "codex_web_search",
            "bedrock_web_search",
            "grok_web_search",
            "grok_x_search",
            "attach",
            "request_secret",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "applet_create",
            "applet_update",
            "applet_revert",
            "applet_list",
            "worklet_install",
            "worklet_update",
            "worklet_revert",
            "worklet_uninstall",
            "worklet_list",
            "worklet_logs",
            "agent_me",
            "agent_info",
            "agent_send",
            "close_agent",
            "resume_agent",
            "send_input",
            "spawn_agent",
            "wait_agent",
        ]);
    });
});
