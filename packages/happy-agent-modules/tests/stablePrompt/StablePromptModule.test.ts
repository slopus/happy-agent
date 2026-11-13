import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { StablePromptModule } from "../../sources/stablePrompt/index.js";
import type { SystemPromptModule } from "../../sources/systemPrompt/index.js";

const ctx = createRootContext().named("stable-prompt-test");
const MESSAGE = { type: "message" } as never;
const INFERENCE = { type: "inference" } as never;

/** One agent's conversation, with the store that lives as long as its current history. */
function conversation(agentsMd: { documents: string } = { documents: "" }) {
    const history = new Map<string, unknown>();
    const module = new StablePromptModule({
        agentsMdDocumentsInPrompt: async () => agentsMd.documents,
    } as unknown as SystemPromptModule);
    const hooks = module.beforeStart();
    const scope = {
        agent: { id: "agent" },
        historyKV: {
            read: async (_ctx: Context, key: string) => history.get(key),
            write: async (_ctx: Context, key: string, value: unknown) => {
                history.set(key, value);
            },
            delete: async (_ctx: Context, key: string) => {
                history.delete(key);
            },
        },
    } as unknown as AgentModuleScope;
    const notices = async (boundary: never): Promise<string[]> =>
        ((await hooks.systemNotificationsTransact!(ctx, scope, boundary)) ?? []).map(
            (message) => (message.content[0] as { text: string }).text,
        );
    return {
        history,
        hooks,
        scope,
        /** Build one request the way Agent Base does: resolve the prompt, then the notices. */
        request: async (instructions: string) => {
            const prompt = await hooks.overrideInstructions!(ctx, scope, {
                instructions,
                contributions: [],
                selection: {} as never,
            });
            return { prompt, notices: await notices(INFERENCE) };
        },
        /** Build a compaction request, which resolves the prompt and appends nothing. */
        compaction: async (instructions: string) =>
            await hooks.overrideInstructions!(ctx, scope, {
                instructions,
                contributions: [],
                selection: {} as never,
            }),
        message: async () => await notices(MESSAGE),
        restarted: () => conversationFrom(history, agentsMd),
    };
}

/** The same history seen by a new process: the store survives, the module's memory does not. */
function conversationFrom(history: Map<string, unknown>, agentsMd: { documents: string }) {
    const next = conversation(agentsMd);
    for (const [key, value] of history) next.history.set(key, value);
    return next;
}

describe("StablePromptModule", () => {
    it("sends the first prompt of a history with every later request", async () => {
        const chat = conversation();
        await chat.message();
        expect(await chat.request("Be brief.\nMode: auto.")).toEqual({
            prompt: "Be brief.\nMode: auto.",
            notices: [],
        });

        // The instructions change while the agent is working: nothing is said mid-turn.
        expect(await chat.request("Be brief.\nMode: read only.")).toEqual({
            prompt: "Be brief.\nMode: auto.",
            notices: [],
        });
        // A compaction request replays the same history, so it gets the same prompt.
        expect(await chat.compaction("Be brief.\nMode: read only.")).toBe("Be brief.\nMode: auto.");
    });

    it("says what changed once, with the first request after a message", async () => {
        const chat = conversation();
        await chat.message();
        await chat.request("Be brief.\nMode: auto.\nUse tabs.");
        await chat.request("Be brief.\nMode: read only.\nUse tabs.");

        expect(await chat.message()).toEqual([]);
        const next = await chat.request("Be brief.\nMode: read only.\nUse tabs.");
        expect(next.prompt).toBe("Be brief.\nMode: auto.\nUse tabs.");
        expect(next.notices).toHaveLength(1);
        expect(next.notices[0]).toMatch(/^# Instructions changed\n/u);
        expect(next.notices[0]).toContain(
            "<removed>\nMode: auto.\n</removed>\n<added>\nMode: read only.\n</added>",
        );
        expect(next.notices[0]).not.toContain("Be brief.");
        expect(next.notices[0]).not.toContain("Use tabs.");

        // The same turn and the next message with nothing new say nothing more.
        expect((await chat.request("Be brief.\nMode: read only.\nUse tabs.")).notices).toEqual([]);
        await chat.message();
        expect((await chat.request("Be brief.\nMode: read only.\nUse tabs.")).notices).toEqual([]);
    });

    it("collapses several changes between two messages into one notice of the outcome", async () => {
        const chat = conversation();
        await chat.message();
        await chat.request("Name: one.\nMode: auto.");
        await chat.request("Name: two.\nMode: auto.");
        await chat.request("Name: three.\nMode: auto.\nA new rule.");

        await chat.message();
        const { notices } = await chat.request("Name: three.\nMode: auto.\nA new rule.");
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain(
            "<removed>\nName: one.\n</removed>\n<added>\nName: three.\n</added>",
        );
        expect(notices[0]).toContain("<added>\nA new rule.\n</added>");
        expect(notices[0]).not.toContain("Name: two.");
    });

    it("says nothing when the instructions are back where the model last heard them", async () => {
        const chat = conversation();
        await chat.message();
        await chat.request("Mode: auto.");
        await chat.request("Mode: read only.");
        await chat.message();
        expect((await chat.request("Mode: auto.")).notices).toEqual([]);
    });

    it("measures a later change from the last notice, not from the prompt", async () => {
        const chat = conversation();
        await chat.message();
        await chat.request("Mode: auto.");
        await chat.message();
        await chat.request("Mode: read only.");
        await chat.message();
        const { prompt, notices } = await chat.request("Mode: full access.");
        expect(prompt).toBe("Mode: auto.");
        expect(notices[0]).toContain(
            "<removed>\nMode: read only.\n</removed>\n<added>\nMode: full access.\n</added>",
        );
    });

    it("keeps the prompt and what was told across a restart", async () => {
        const chat = conversation();
        await chat.message();
        await chat.request("Mode: auto.");
        await chat.message();
        await chat.request("Mode: read only.");

        const restarted = chat.restarted();
        await restarted.message();
        expect(await restarted.request("Mode: read only.")).toEqual({
            prompt: "Mode: auto.",
            notices: [],
        });
    });

    it("takes the current instructions as the prompt once the history was rebuilt", async () => {
        const chat = conversation();
        await chat.message();
        await chat.request("Mode: auto.");
        await chat.message();

        // Compaction, an incompatible model change, and an overflow reset all empty the store.
        chat.history.clear();
        expect(await chat.request("Mode: read only.")).toEqual({
            prompt: "Mode: read only.",
            notices: [],
        });
        await chat.message();
        expect((await chat.request("Mode: read only.")).notices).toEqual([]);
    });

    it("leaves AGENTS.md to its own superseding notice", async () => {
        const agentsMd = { documents: "# AGENTS.md instructions for /repo\n\nUse tabs." };
        const chat = conversation(agentsMd);
        const prompt = (documents: string, mode: string) =>
            `Be brief.\n\nAbout AGENTS.md.\n\n${documents}\n\nMode: ${mode}.`;
        await chat.message();
        const first = await chat.request(prompt(agentsMd.documents, "auto"));

        agentsMd.documents = "# AGENTS.md instructions for /repo\n\nUse spaces.\nNo semicolons.";
        await chat.message();
        const edited = await chat.request(prompt(agentsMd.documents, "auto"));
        // The prompt keeps the copy it began with; the file's own notice carries the new one.
        expect(edited).toEqual({ prompt: first.prompt, notices: [] });

        await chat.message();
        const both = await chat.request(prompt(agentsMd.documents, "read only"));
        expect(both.notices).toHaveLength(1);
        expect(both.notices[0]).toContain("Mode: read only.");
        expect(both.notices[0]).not.toContain("Use spaces.");
        expect(both.notices[0]).not.toContain("Use tabs.");
    });

    it("forgets a resolved request that was never sent once the run ends", async () => {
        const chat = conversation();
        await chat.message();
        await chat.compaction("Mode: auto.");
        await chat.hooks.afterAgentSettledTransact!(ctx, chat.scope, {} as never);
        // Nothing was resolved for this request, so there is nothing to store or to say.
        expect(await chat.hooks.systemNotificationsTransact!(ctx, chat.scope, INFERENCE)).toBe(
            undefined,
        );
        expect(chat.history.has("prompt")).toBe(false);
    });
});
