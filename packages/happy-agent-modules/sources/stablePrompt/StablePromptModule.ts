import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { SystemPromptModule } from "../systemPrompt/index.js";
import { diffInstructionLines } from "./impl/diffInstructionLines.js";
import { formatInstructionsChange } from "./impl/formatInstructionsChange.js";

/** The system prompt this history was started with, sent verbatim with every request. */
const PROMPT_KEY = "prompt";
/** The instructions this history was last told, through its prompt or a later notice. */
const TOLD_KEY = "told";
/** Set when a message arrived, so the next request may say what changed since. */
const DUE_KEY = "due";
const textSchema = Type.String();

interface Instructions {
    /** The complete provider-facing instructions as every module would write them now. */
    readonly current: string;
    /** The same text without the part another notice already keeps up to date. */
    readonly comparable: string;
}

/**
 * Keeps one system prompt for the life of a history, and appends what changes afterwards.
 *
 * Every module's instructions are rebuilt before every request, and many of them describe things
 * that change: the permission mode, the model, what is installed, who the agent is. A provider
 * caches the system prompt and everything after it, so a prompt that changed threw the whole
 * cache away. Claude models with preserved thinking go further: each thinking block is bound to
 * the system prompt it was produced under, and a request replaying one under another prompt is
 * rejected, which ends the conversation.
 *
 * So the first prompt a history is sent is stored in that history's own store and returned for
 * every later request, inference and compaction alike, across turns and restarts. The store is
 * emptied exactly where the history is rebuilt (compaction, an incompatible model or profile
 * change, a context overflow reset), and nothing earlier is replayed after that, so the next
 * request takes the current instructions as its prompt.
 *
 * Changes reach the model as a notice. When a message has arrived, the next request compares the
 * current instructions with what the history was last told and appends the lines that differ.
 * A change that lands while the agent is working waits for the next message, and never starts a
 * turn. Several changes between two messages are one notice.
 *
 * This module must be the last one in the list: its override has to see the prompt every other
 * module and override produced, because that is what the provider would have been sent.
 */
export class StablePromptModule implements AgentModule {
    readonly name = "stable-prompt";

    /** Which part of the prompt already has a superseding notice of its own. */
    readonly #systemPrompt: SystemPromptModule;
    /**
     * The instructions resolved for a request that is being built, by agent. The override hook
     * leaves them here and the notification hook of the same request takes them, so they are
     * held for the length of one request and never read after a restart.
     */
    readonly #resolved = new Map<string, Instructions>();

    constructor(systemPrompt: SystemPromptModule) {
        this.#systemPrompt = systemPrompt;
    }

    readonly #hooks: AgentModuleHooks = {
        overrideInstructions: async (ctx, scope, input) => {
            // AGENTS.md is delivered again in full whenever it changes, so it is not ours to diff.
            const documents = await this.#systemPrompt.agentsMdDocumentsInPrompt(ctx, scope);
            this.#resolved.set(scope.agent.id, {
                current: input.instructions,
                comparable:
                    documents.length === 0
                        ? input.instructions
                        : input.instructions.replace(documents, () => ""),
            });
            const prompt = await scope.historyKV.read(ctx, PROMPT_KEY);
            return Value.Check(textSchema, prompt) ? prompt : input.instructions;
        },

        systemNotificationsTransact: async (ctx, scope, boundary) => {
            if (boundary.type === "message") {
                await scope.historyKV.write(ctx, DUE_KEY, true);
                return;
            }
            const resolved = this.#resolved.get(scope.agent.id);
            this.#resolved.delete(scope.agent.id);
            if (resolved === undefined) return;
            if (!Value.Check(textSchema, await scope.historyKV.read(ctx, PROMPT_KEY))) {
                // The request being built is the first of this history: what it sends is the
                // prompt from now on, committed before the request leaves.
                await scope.historyKV.write(ctx, PROMPT_KEY, resolved.current);
                await scope.historyKV.write(ctx, TOLD_KEY, resolved.comparable);
                await scope.historyKV.delete(ctx, DUE_KEY);
                return;
            }
            if ((await scope.historyKV.read(ctx, DUE_KEY)) !== true) return;
            await scope.historyKV.delete(ctx, DUE_KEY);
            const told = await scope.historyKV.read(ctx, TOLD_KEY);
            if (!Value.Check(textSchema, told) || told === resolved.comparable) return;
            await scope.historyKV.write(ctx, TOLD_KEY, resolved.comparable);
            const changes = diffInstructionLines(told, resolved.comparable);
            if (changes.length === 0) return;
            return [
                {
                    role: "system",
                    content: [{ type: "text", text: formatInstructionsChange(changes) }],
                },
            ];
        },

        /** A request that was resolved and never sent leaves nothing behind once the run ends. */
        afterAgentSettledTransact: (_ctx, scope) => {
            this.#resolved.delete(scope.agent.id);
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
