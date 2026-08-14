import { Agent, AgentProviders, type AgentFeatureScope } from "@slopus/happy-agent-base";
import type { SessionMessage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { HistoryFeature, ModelSwitchFeature } from "../../sources/index.js";
import { InMemoryHistoryStore } from "../support/InMemoryHistoryStore.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { sharedKV, textTurn, user } from "../support/fixtures.js";

const ctx = createRootContext().named("happy-agent-features-model-switch");

/** Every system text a session was sent, across every inference of a run. */
function systemTexts(messages: readonly SessionMessage[]): string[] {
    return messages.flatMap((message) =>
        message.role === "system"
            ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
    );
}

/** An agent that can move between an OpenAI model and an Anthropic one, which cannot mix. */
async function switchingAgent() {
    const codex = new ScriptedProvider([textTurn("answered on codex")]);
    const claude = new ScriptedProvider([textTurn("answered on claude")]);
    const providers = new AgentProviders();
    providers.add("codex", codex, "codex");
    providers.add("claude", claude, "claude");
    const agent = await Agent.create(ctx, {
        id: "switching-agent",
        providers,
        provider: "codex",
        model: "openai/gpt-5.6-sol",
        persistence: new InMemoryPersistence(),
        sharedKV: sharedKV(),
        features: [new ModelSwitchFeature({ historyTool: "read_agent_history" })],
    });
    return { agent, claude, codex };
}

/** A scope naming only what the feature reads off it: whose switch this is. */
function scopeOf(agentId: string): AgentFeatureScope {
    return { agent: { id: agentId } } as AgentFeatureScope;
}

describe("ModelSwitchFeature", () => {
    it("tells the new model a conversation it cannot see came before", async () => {
        const { agent, claude } = await switchingAgent();

        await agent.send(ctx, user("first question"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("second question"), {
            await: true,
            provider: "claude",
            model: "anthropic/opus-5",
        });
        await agent.waitForIdle();
        await agent.close();

        const session = claude.sessions[0];
        if (session === undefined) throw new Error("The agent never opened a Claude session.");
        const request = session.requests[0];
        if (request === undefined) throw new Error("The new model was never asked anything.");
        const notice = systemTexts(request.context.messages).join("\n");
        expect(notice).toContain(
            "changed from openai/gpt-5.6-sol on codex to anthropic/opus-5 on claude",
        );
        expect(notice).toContain("investigate the prior agent history");
        expect(notice).toContain("none of it is visible to you");
        expect(notice).toContain("read_agent_history");
        // A model told it was handed something acts as though it already knows what was decided.
        expect(notice.toLocaleLowerCase()).not.toContain("handoff");
        expect(notice.toLocaleLowerCase()).not.toContain("handed off");
        // The erased history is gone; the notice is what stands in its place.
        expect(request.context.messages.filter((message) => message.role === "user")).toHaveLength(
            1,
        );
    });

    it("says nothing when the switch keeps the conversation", async () => {
        const { agent, codex } = await switchingAgent();

        await agent.send(ctx, user("first question"), { await: true });
        await agent.waitForIdle();
        await agent.send(ctx, user("second question"), {
            await: true,
            model: "openai/gpt-5.6-terra",
        });
        await agent.waitForIdle();
        await agent.close();

        const asked = codex.sessions.flatMap((session) => session.requests);
        const last = asked.at(-1);
        if (last === undefined) throw new Error("The model was never asked anything.");
        expect(systemTexts(last.context.messages)).toHaveLength(0);
        expect(last.context.messages.filter((message) => message.role === "user")).toHaveLength(2);
    });

    it("quotes both ends of the conversation it is replacing, when a history keeps one", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const feature = new ModelSwitchFeature({ history, historyTool: "read_agent_history" });
        for (let index = 0; index < 15; index += 1) {
            await history.record(ctx, "remembering-agent", {
                role: index % 2 === 0 ? "user" : "assistant",
                blocks: [{ type: "text", text: `MESSAGE_${index + 1}` }],
            });
        }

        const notice = await feature.modelChanged(ctx, scopeOf("remembering-agent"), {
            previousModel: "openai/gpt-5.6-sol",
            model: "anthropic/opus-5",
            previousProvider: "codex",
            provider: "claude",
            providers: new AgentProviders(),
            wasReset: true,
        });

        const text = notice?.content[0]?.text ?? "";
        expect(text).toContain("History overview: 15 messages, 8 user messages");
        expect(text).toContain("Beginning history excerpt:");
        expect(text).toContain("Recent history excerpt:");
        // Both ends survive; the middle is what a bounded excerpt gives up.
        for (const included of [1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15]) {
            expect(text).toContain(`MESSAGE_${included}`);
        }
        for (const omitted of [5, 6, 7]) {
            expect(text).not.toContain(`MESSAGE_${omitted}`);
        }
    });

    it("reads the true ends of a long history without loading its middle", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        const reads: Array<{ from?: "end" | "start"; limit?: number }> = [];
        const reader = {
            messages: async (
                readCtx: typeof ctx,
                agentId: string,
                query: { from?: "end" | "start"; limit?: number },
            ) => {
                reads.push(query);
                return history.messages(readCtx, agentId, query);
            },
        };
        for (let index = 0; index < 251; index += 1) {
            await history.record(ctx, "long-agent", {
                role: "user",
                blocks: [{ type: "text", text: `M${index}` }],
            });
        }

        const notice = await new ModelSwitchFeature({ history: reader }).modelChanged(
            ctx,
            scopeOf("long-agent"),
            {
                previousModel: "openai/gpt-5.6-sol",
                model: "anthropic/opus-5",
                previousProvider: "codex",
                provider: "claude",
                providers: new AgentProviders(),
                wasReset: true,
            },
        );

        const text = notice?.content[0]?.text ?? "";
        expect(reads).toEqual([
            { from: "start", limit: 100 },
            { from: "end", limit: 100 },
        ]);
        expect(text).toContain("M0");
        expect(text).toContain("M249");
        expect(text).toContain("M250");
        expect(text).not.toContain("M50");
        expect(text).not.toContain("M100");
        expect(text).toContain("History sample overview");
        expect(text).not.toContain("History overview: 251 messages");
    });

    it("uses exact bounded archive statistics instead of sample counts", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        for (let index = 0; index < 251; index += 1) {
            await history.record(ctx, "exact-stats-agent", {
                role: "user",
                blocks: [{ type: "text", text: `EXACT_${index}` }],
            });
        }

        const notice = await new ModelSwitchFeature({ history }).modelChanged(
            ctx,
            scopeOf("exact-stats-agent"),
            {
                previousModel: "openai/gpt-5.6-sol",
                model: "anthropic/opus-5",
                previousProvider: "codex",
                provider: "claude",
                providers: new AgentProviders(),
                wasReset: true,
            },
        );

        const text = notice?.content[0]?.text ?? "";
        expect(text).toContain("History overview: 251 messages");
        expect(text).not.toContain("History sample overview");
    });

    it("downgrades under-reporting archive statistics to a sampled overview", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        for (let index = 0; index < 200; index += 1) {
            await history.record(ctx, "under-reporting-agent", {
                role: index % 2 === 0 ? "user" : "assistant",
                blocks: [
                    { type: "text", text: `UNDER_REPORTED_${index}` },
                    ...(index === 0
                        ? [{ type: "thinking" as const, thinking: "one thought" }]
                        : []),
                    ...(index === 1
                        ? [
                              {
                                  arguments: {},
                                  callId: "under-reported-call",
                                  name: "under-reported-tool",
                                  type: "tool_call" as const,
                              },
                          ]
                        : []),
                    ...(index === 2
                        ? [
                              {
                                  callId: "under-reported-call",
                                  output: "one result",
                                  toolName: "under-reported-tool",
                                  type: "tool_result" as const,
                              },
                          ]
                        : []),
                ],
            });
        }

        const reader = {
            messages: (
                readCtx: typeof ctx,
                agentId: string,
                query: { from?: "end" | "start"; limit?: number },
            ) => history.messages(readCtx, agentId, query),
            stats: async () => ({
                assistantMessages: 0,
                messages: 1,
                textCharacters: 1,
                thinkingBlocks: 0,
                toolCalls: 0,
                toolResults: 0,
                userMessages: 1,
            }),
        };
        const notice = await new ModelSwitchFeature({ history: reader }).modelChanged(
            ctx,
            scopeOf("under-reporting-agent"),
            {
                previousModel: "openai/gpt-5.6-sol",
                model: "anthropic/opus-5",
                previousProvider: "codex",
                provider: "claude",
                providers: new AgentProviders(),
                wasReset: true,
            },
        );

        const text = notice?.content[0]?.text ?? "";
        expect(text).toContain("History sample overview");
        expect(text).toContain("200 messages, 100 user messages, 100 assistant messages");
        expect(text).toContain("1 thinking blocks, 1 tool calls, 1 tool results");
        expect(text).not.toContain("History overview: 1 messages");
    });

    it("deduplicates the overlap when both bounded reads cover a short history", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        for (let index = 0; index < 5; index += 1) {
            await history.record(ctx, "short-agent", {
                role: "user",
                blocks: [{ type: "text", text: `SHORT_${index}` }],
            });
        }

        const notice = await new ModelSwitchFeature({ history }).modelChanged(
            ctx,
            scopeOf("short-agent"),
            {
                previousModel: "openai/gpt-5.6-sol",
                model: "anthropic/opus-5",
                previousProvider: "codex",
                provider: "claude",
                providers: new AgentProviders(),
                wasReset: true,
            },
        );

        expect(notice?.content[0]?.text).toContain("History overview: 5 messages");
    });

    it("still switches when the history cannot be read", async () => {
        const store = new InMemoryHistoryStore();
        const history = new HistoryFeature({ store });
        await history.record(ctx, "unlucky-agent", {
            role: "user",
            blocks: [{ type: "text", text: "something happened" }],
        });
        store.broken = true;

        const notice = await new ModelSwitchFeature({ history }).modelChanged(
            ctx,
            scopeOf("unlucky-agent"),
            {
                previousModel: "openai/gpt-5.6-sol",
                model: "anthropic/opus-5",
                previousProvider: "codex",
                provider: "claude",
                providers: new AgentProviders(),
                wasReset: true,
            },
        );

        const text = notice?.content[0]?.text ?? "";
        expect(text).toContain("changed from openai/gpt-5.6-sol on codex");
        expect(text).not.toContain("History overview");
    });

    it("leaves out the history tool when the agent has none", async () => {
        const notice = await new ModelSwitchFeature().modelChanged(ctx, scopeOf("lonely-agent"), {
            previousModel: "openai/gpt-5.6-sol",
            model: "anthropic/opus-5",
            previousProvider: "codex",
            provider: "claude",
            providers: new AgentProviders(),
            wasReset: true,
        });

        const text = notice?.content[0]?.text ?? "";
        expect(text).toContain("Durable history lookup is unavailable in this runtime");
        expect(text).not.toContain("read_agent_history");
    });
});
