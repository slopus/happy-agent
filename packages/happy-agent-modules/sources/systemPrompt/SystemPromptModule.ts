import {
    agentEnvironment,
    agentEnvironmentSchema,
    type AgentBaseAcceptedMessage,
    type AgentModule,
    type AgentModuleAction,
    type AgentModuleHooks,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { join } from "node:path";

import type { ConfigModule } from "../config/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { AgentsMdSnapshot } from "./AgentsMd.js";
import { AgentsMdInstructions } from "./impl/agentsMdInstructions.js";
import {
    assembleEnvironmentPrompt,
    formatAvailableModels,
} from "./impl/assembleEnvironmentPrompt.js";
import { systemPromptForModel } from "./impl/systemPromptForModel.js";
import {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    systemPromptIdentitySchema,
    type SystemPromptIdentity,
} from "./SystemPromptIdentity.js";
import {
    systemPromptSelectionSchema,
    type SystemPromptSelection,
} from "./SystemPromptSelection.js";
import {
    MAX_SYSTEM_PROMPT_AVAILABLE_MODEL_FIELD_LENGTH,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
    type SystemPromptAvailableModel,
    type SystemPromptAvailableModels,
} from "./SystemPromptAvailableModel.js";

const IDENTITY_MARKER = "{{identity}}";
const NAME_MARKER = "{{name}}";
const AGENTS_MD_OUTPUT_TRUNCATION_NOTICE =
    "[Some AGENTS.md instruction content was omitted to stay within the system prompt byte limit.]";
const INVALID_AVAILABLE_MODELS_ERROR = "System prompt available models are invalid.";
const AVAILABLE_MODELS_BYTE_BOUND_ERROR =
    "System prompt available models exceed the configured UTF-8 byte bound.";

/** The largest prompt output accepted after identity substitution. */
export const MAX_SYSTEM_PROMPT_OUTPUT_BYTES = 1_000_000;

export {
    MAX_SYSTEM_PROMPT_AVAILABLE_MODEL_FIELD_LENGTH,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
    systemPromptIdentitySchema,
    systemPromptSelectionSchema,
};
export type { SystemPromptSelection };
export type { SystemPromptAvailableModel, SystemPromptAvailableModels };

/**
 * The instructions a model is written for.
 *
 * Every model is trained differently and is told how to behave in its own words, so the prompt
 * an agent runs on follows the model it is running rather than the agent. The module reads the
 * selection from the scope it is handed, so an agent that switches models mid-conversation is
 * given the new model's prompt on the very next inference without anything else changing. A model
 * nobody has written a prompt for gets the simple one, so there is always a prompt.
 *
 * It holds no tuning of its own and takes no lock: the answer depends on the model in force, the
 * attached environment, and what configuration says, so any number of agents may ask at once.
 */
export class SystemPromptModule implements AgentModule {
    readonly name = "system-prompt";

    /**
     * Who the agent says it is, substituted into whichever prompt is chosen.
     *
     * There is one identity, and it is Happy Agent's own: an installation that renamed itself would be
     * telling the model it is something the rest of the product is not.
     */
    readonly #identity: SystemPromptIdentity = DEFAULT_SYSTEM_PROMPT_IDENTITY;
    /** Where the model catalog and the person's own instructions come from. */
    readonly #config: ConfigModule;
    /** Live AGENTS.md discovery and durable change-notice behavior. */
    readonly #agentsMd: AgentsMdInstructions;

    constructor(config: ConfigModule, compute: ComputeModule) {
        this.#config = config;
        this.#agentsMd = new AgentsMdInstructions(config, compute);
    }

    /**
     * The routes the environment section prints, taken from configuration.
     *
     * Configuration owns which accounts exist and which models they serve, so the catalog is read
     * from it rather than restated here. Provider scans and explicit overrides can change it while
     * the daemon is running, so it is rebuilt for each inference.
     */
    get #models(): readonly SystemPromptAvailableModel[] {
        const models = this.#config.models.map(({ id, name, providerId }) => ({
            id,
            name,
            providerId,
        }));
        if (!Value.Check(systemPromptAvailableModelsSchema, models)) {
            throw new Error(INVALID_AVAILABLE_MODELS_ERROR);
        }
        if (
            new TextEncoder().encode(formatAvailableModels(models)).byteLength >
            MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES
        ) {
            throw new Error(AVAILABLE_MODELS_BYTE_BOUND_ERROR);
        }
        return Object.freeze(models.map((model) => Object.freeze(model)));
    }

    /** The prompt this model is written for, ready to use. */
    promptFor(selection: SystemPromptSelection): string {
        if (!Value.Check(systemPromptSelectionSchema, selection)) {
            throw new Error("System prompt model selection is invalid.");
        }
        const prompt = systemPromptForModel(selection)
            .replaceAll(NAME_MARKER, () => this.#identity.name.trim())
            .replace(IDENTITY_MARKER, () => this.#identity.prompt.trim());
        if (new TextEncoder().encode(prompt).byteLength > MAX_SYSTEM_PROMPT_OUTPUT_BYTES) {
            throw new Error("The system prompt exceeds the configured output bound.");
        }
        return prompt;
    }

    /** Read the current global, security, and project AGENTS.md snapshot. */
    async readAgentsMd(ctx: Context, agentId: string): Promise<AgentsMdSnapshot | undefined> {
        return await this.#agentsMd.read(ctx, agentId);
    }

    /**
     * Read the current AGENTS.md context formatted as the same instruction text every model
     * receives, or `undefined` when there is none. The automatic permission reviewer appends this
     * after its guardian policy so a review sees the project's own intent, reread every time.
     */
    async readAgentsMdInstructions(ctx: Context, agentId: string): Promise<string | undefined> {
        return await this.#agentsMd.readFormatted(ctx, agentId);
    }

    async #instructions(ctx: Context, scope: AgentModuleScope): Promise<string> {
        const prompt = this.promptFor({
            model: scope.agent.model,
            ...(scope.agent.providerKind === undefined
                ? {}
                : { providerKind: scope.agent.providerKind }),
        });
        const environment = agentEnvironment(ctx);
        const sections = [prompt];
        if (environment !== undefined) {
            if (!Value.Check(agentEnvironmentSchema, environment)) {
                throw new Error("The agent environment is invalid.");
            }
            sections.push(
                assembleEnvironmentPrompt({
                    environment,
                    availableModels: this.#models,
                    currentModel: scope.agent.model,
                    currentProvider: scope.agent.provider,
                    designSystemPath: join(this.#config.configuration.paths.docsHome, "DESIGN.md"),
                    documentationPath: join(this.#config.configuration.paths.docsHome, "README.md"),
                }),
            );
        }
        const agentsMdInstructions = await this.#agentsMd.instructions(ctx, scope);
        const promptBeforeAgentsMd = sections.join("\n\n");
        const agentsMdBudget =
            MAX_SYSTEM_PROMPT_OUTPUT_BYTES -
            new TextEncoder().encode(promptBeforeAgentsMd).byteLength -
            (agentsMdInstructions.length === 0 ? 0 : 2);
        const boundedAgentsMd = truncateUtf8WithNotice(agentsMdInstructions, agentsMdBudget);
        if (boundedAgentsMd.length > 0) sections.push(boundedAgentsMd);
        const fullPrompt = sections.join("\n\n");
        if (new TextEncoder().encode(fullPrompt).byteLength > MAX_SYSTEM_PROMPT_OUTPUT_BYTES) {
            throw new Error("The system prompt exceeds the configured output bound.");
        }
        return fullPrompt;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: (ctx: Context, scope: AgentModuleScope): Promise<string> =>
            this.#instructions(ctx, scope),

        beforeTurn: async (
            ctx: Context,
            scope: AgentModuleScope,
        ): Promise<readonly AgentModuleAction[] | undefined> =>
            await this.#agentsMd.beforeTurn(ctx, scope),

        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => await this.#agentsMd.messageAcceptedTransact(ctx, scope, accepted),
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

function truncateUtf8WithNotice(value: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).byteLength <= maxBytes) return value;
    if (maxBytes <= 0) return "";

    const suffix = `\n\n${AGENTS_MD_OUTPUT_TRUNCATION_NOTICE}`;
    const suffixBytes = encoder.encode(suffix).byteLength;
    if (suffixBytes >= maxBytes)
        return decodeUtf8Prefix(AGENTS_MD_OUTPUT_TRUNCATION_NOTICE, maxBytes);
    return `${decodeUtf8Prefix(value, maxBytes - suffixBytes)}${suffix}`;
}

function decodeUtf8Prefix(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const bytes = new TextEncoder().encode(value);
    let end = Math.min(maxBytes, bytes.byteLength);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
        try {
            return decoder.decode(bytes.subarray(0, end));
        } catch {
            end -= 1;
        }
    }
    return "";
}
