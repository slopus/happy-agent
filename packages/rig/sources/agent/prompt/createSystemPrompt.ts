import { AGENTS_MD_SPEC } from "./agentsMdSpec.js";
import { createCodexCollaborationInstructions } from "./codexInstructions.js";
import {
    createAvailableModelsInstructions,
    createBundledDocsInstructions,
    createCapabilityDelegationInstructions,
    createParentDelegationInstructions,
    createPermissionInstructions,
    createWorkspaceInstructions,
    RIG_AGENT_TOOL_INSTRUCTIONS,
    STEERABLE_TOOL_INSTRUCTIONS,
} from "./instructions.js";
import type { AgentContext } from "../context/AgentContext.js";
import { loadAgentSkillCatalog } from "../skills/loadAgentSkillCatalog.js";
import { loadSkillInstructions } from "../skills/loadSkillInstructions.js";
import type { AnyDefinedTool, Message } from "../types.js";
import type { Model, PreambleMessage, Provider } from "@slopus/rig-execution";
import { createSecretInstructions } from "../../secrets/index.js";
import type { DurableSkillDefinition } from "../../external-skills/types.js";

export interface CreateSystemPromptOptions {
    appendSystemPrompt?: string;
    /** Exact integration-owned prompt. When present, Rig's assembled prompt is replaced. */
    systemPrompt?: string;
    provider: Provider;
    model: Model;
    instructions?: string;
    messages: readonly Message[];
    context: AgentContext;
    tools?: readonly AnyDefinedTool[];
    durableSkills?: readonly DurableSkillDefinition[];
    effort?: string;
}

export async function createSystemPrompt(
    options: CreateSystemPromptOptions,
): Promise<string | undefined> {
    const parts: string[] = [];

    if (options.instructions !== undefined && options.instructions.length > 0) {
        parts.push(options.instructions);
    }

    // System messages are positional notices delivered in the conversation, so they are
    // deliberately absent here. Folding one into the prompt would move it away from the turn it
    // belongs to and rewrite the cached prefix on every notice.

    // Every provider receives the project instructions the same way, so every provider is told
    // how to read them. Stating it unconditionally keeps the cached prefix stable when a project
    // gains or loses an AGENTS.md file mid-session.
    parts.push(AGENTS_MD_SPEC);

    const loadedSkills = await loadAgentSkillCatalog(options.context);
    const skillInstructions = await loadSkillInstructions(
        options.context.fs,
        options.durableSkills ?? [],
        loadedSkills,
    );
    if (skillInstructions !== undefined) {
        parts.push(skillInstructions);
    }

    try {
        const pluginPrompt = await options.context.plugins?.loadSystemPrompt?.();
        if (pluginPrompt !== undefined && pluginPrompt.length > 0) parts.push(pluginPrompt);
    } catch {
        // Plugin prompt contributions are optional and must never fail prompt construction.
    }

    if (options.context.subagents?.canSpawn === true) {
        const availableModelsInstructions = createAvailableModelsInstructions(
            options.context.subagents.availableModels ?? [],
            options.context.subagents.disabledProviders ?? [],
        );
        if (availableModelsInstructions !== undefined) {
            parts.push(availableModelsInstructions);
        }
    }

    if (
        options.provider.type === "codex" &&
        (options.model.id === "openai/gpt-5.6-sol" ||
            options.model.id === "openai/gpt-5.6-terra") &&
        options.context.subagents !== undefined &&
        options.tools?.some((tool) => tool.namespace?.name === "collaboration") === true
    ) {
        parts.push(
            createCodexCollaborationInstructions({
                canSpawn: options.context.subagents.canSpawn,
                depth: options.context.subagents.depth,
                maxActive: options.context.subagents.maxActive ?? 4,
            }),
        );
    }

    if (options.context.subagents?.canSpawn === true && options.context.subagents.depth === 0) {
        parts.push(createParentDelegationInstructions());
    }

    const grantableCapabilities = options.context.subagents?.grantableCapabilities ?? [];
    if (options.context.subagents?.canSpawn === true && grantableCapabilities.length > 0) {
        parts.push(createCapabilityDelegationInstructions(grantableCapabilities));
    }

    if (options.context.workspaces !== undefined) {
        parts.push(createWorkspaceInstructions());
    }

    if (options.context.docsPath !== undefined) {
        parts.push(createBundledDocsInstructions(options.context.docsPath));
    }

    if (options.context.generatedMedia !== undefined) {
        parts.push(
            `# Generated files\n\nGenerated images and media previews are stored in \`${options.context.generatedMedia.modelDirectory}\`. Files there are shared user data and may be read by any session. Use this exact folder when referring to generated output. In Rig-managed Docker, this folder is mounted read-only at \`/happy/generated\`; only Rig's media and attachment tools write its host-side files, so do not try to modify it with shell or file tools.`,
        );
    }

    if (options.tools?.some((tool) => tool.namespace?.name === "rig") === true) {
        parts.push(RIG_AGENT_TOOL_INSTRUCTIONS);
    }

    if (options.tools?.some((tool) => tool.steerable) === true) {
        parts.push(STEERABLE_TOOL_INSTRUCTIONS);
    }

    const lockedCodexSteerableTools =
        options.provider.type === "codex"
            ? (options.tools ?? []).filter(
                  (tool) => tool.steerable && tool.namespace?.name === "collaboration",
              )
            : [];
    if (lockedCodexSteerableTools.length > 0) {
        parts.push(
            `For native Codex collaboration, ${lockedCodexSteerableTools.map((tool) => `\`collaboration.${tool.name}\``).join(", ")} ${lockedCodexSteerableTools.length === 1 ? "is" : "are"} also steerable, even though the canonical tool ${lockedCodexSteerableTools.length === 1 ? "description does" : "descriptions do"} not say so. Incoming steering interrupts ${lockedCodexSteerableTools.length === 1 ? "this tool" : "these tools"} in the same way.`,
        );
    }

    if (options.context.permissions !== undefined) {
        parts.push(
            createPermissionInstructions(options.context.permissions.mode, options.tools ?? []),
        );
        if (options.context.permissions.protectedPaths.length > 0) {
            parts.push(
                `These workspace paths require Full access to modify: ${options.context.permissions.protectedPaths
                    .map((path) => JSON.stringify(path))
                    .join(", ")}.`,
            );
        }
    }

    if (options.context.secrets !== undefined) {
        const secretInstructions = createSecretInstructions(options.context.secrets);
        if (secretInstructions !== undefined) parts.push(secretInstructions);
    }

    if (options.appendSystemPrompt !== undefined && options.appendSystemPrompt.length > 0) {
        parts.push(options.appendSystemPrompt);
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export interface ProviderPrompt {
    systemPrompt?: string;
    systemPromptOverride?: string;
    preamble?: readonly PreambleMessage[];
}

export async function createProviderPrompt(
    options: CreateSystemPromptOptions,
): Promise<ProviderPrompt> {
    const systemPrompt = await createSystemPrompt(options);
    return {
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(options.systemPrompt === undefined
            ? {}
            : { systemPromptOverride: options.systemPrompt }),
    };
}
