import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    AgentProviders,
    type AgentBaseHooks,
    type AgentBaseModelChange,
} from "../sources/index.js";
import { system, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("provider-switch-test");

describe("switching away from an unavailable provider", () => {
    it.each([
        { unavailable: "disabled", restart: false },
        { unavailable: "disabled", restart: true },
        { unavailable: "removed", restart: false },
        { unavailable: "removed", restart: true },
    ] as const)(
        "continues the same agent when $unavailable (restart: $restart)",
        async ({ unavailable, restart }) => {
            const persistence = new InMemoryPersistence();
            const previous = Object.assign(new ScriptedProvider([textTurn("Original answer")]), {
                region: "us-east-1",
            });
            const replacement = Object.assign(
                new ScriptedProvider([
                    textTurn("Replacement answer"),
                    textTurn("Follow-up answer"),
                ]),
                { region: "us-east-1" },
            );
            let enabled = true;
            const providers = new AgentProviders();
            providers.add(
                "bedrock",
                () => {
                    if (!enabled) throw new Error('Provider "bedrock" is disabled.');
                    return previous;
                },
                "bedrock",
            );
            providers.add("bee-dev", replacement, "bedrock");
            const changes: AgentBaseModelChange[] = [];
            const accepted: string[] = [];
            const events: SessionEvent[] = [];
            const options = {
                id: "existing-bot",
                provider: "bedrock",
                model: "openai/gpt-x",
                persistence,
                providers,
                hooks: {
                    modelChanged: (_ctx, change) => {
                        changes.push(change);
                        return system(
                            "Continue the existing work; the original answer is archived.",
                        );
                    },
                    messageAccepted: (_ctx, message) => {
                        accepted.push(message.id);
                    },
                    onEvent: (_ctx, event) => {
                        events.push(event);
                    },
                } satisfies AgentBaseHooks,
            };
            let agent = await AgentBase.create(ctx, options);
            try {
                await agent.send(ctx, user("Original request"), { id: "originalrequest" });
                await agent.waitForIdle();
                expect(previous.sessions[0]?.requests).toHaveLength(1);
                if (restart) await agent.close();
                if (unavailable === "removed") providers.remove("bedrock");
                else enabled = false;
                if (restart) agent = await AgentBase.load(ctx, options);

                await agent.send(ctx, user("Continue with Bee Dev"), {
                    id: "switchrequest",
                    provider: "bee-dev",
                });
                await agent.waitForIdle();

                expect(
                    events.filter((event) => event.type === "done" && event.state === "error"),
                ).toEqual([]);
                expect(agent.id).toBe("existing-bot");
                expect(changes).toEqual([
                    expect.objectContaining({
                        previousProvider: "bedrock",
                        provider: "bee-dev",
                        wasReset: true,
                    }),
                ]);
                expect(previous.sessions[0]?.destroyed).toBe(true);
                expect(replacement.sessions[0]?.requests[0]?.context.messages).toEqual([
                    system("Continue the existing work; the original answer is archived."),
                    user("Continue with Bee Dev"),
                ]);
                expect(accepted).toEqual(["originalrequest", "switchrequest"]);
                expect(persistence.values.get("settings")).toMatchObject({ provider: "bee-dev" });
                expect(
                    [...persistence.values.keys()].filter((key) => key.startsWith("send.")),
                ).toEqual([]);

                // A restart and a message without an override must keep using the replacement.
                await agent.close();
                agent = await AgentBase.load(ctx, options);
                await agent.send(ctx, user("One more thing"), { id: "followuprequest" });
                await agent.waitForIdle();
                expect(replacement.sessions[1]?.requests[0]?.context.messages).toEqual([
                    system("Continue the existing work; the original answer is archived."),
                    user("Continue with Bee Dev"),
                    { role: "assistant", content: [{ type: "text", text: "Replacement answer" }] },
                    user("One more thing"),
                ]);
                expect(accepted).toEqual(["originalrequest", "switchrequest", "followuprequest"]);
            } finally {
                await agent.close();
            }
        },
    );

    it("does not swallow a failure resolving the newly selected provider", async () => {
        const previous = Object.assign(new ScriptedProvider([textTurn("Original answer")]), {
            region: "us-east-1",
        });
        const providers = new AgentProviders();
        providers.add("bedrock", previous, "bedrock");
        providers.add(
            "bee-dev",
            () => {
                throw new Error("Replacement credentials are unavailable.");
            },
            "bedrock",
        );
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "existing-bot",
            providers,
            provider: "bedrock",
            model: "openai/gpt-x",
            persistence,
            hooks: {
                onEvent: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        try {
            await agent.send(ctx, user("Original request"), { provider: "bedrock" });
            await agent.waitForIdle();
            await agent.send(ctx, user("Switch"), { provider: "bee-dev" });
            await agent.waitForIdle();
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: "done",
                    state: "error",
                    message: "Replacement credentials are unavailable.",
                }),
            );
            expect(previous.sessions[0]?.requests).toHaveLength(1);
            expect(persistence.values.get("settings")).toMatchObject({ provider: "bedrock" });
            expect(
                [...persistence.values.keys()].filter((key) => key.startsWith("send.")),
            ).toHaveLength(1);
        } finally {
            await agent.close();
        }
    });
});
