import { withTracer, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    EventsModule,
    SlashCommandInputError,
    SlashCommandNotFoundError,
    SlashCommandsModule,
    type SlashCommandContributor,
    type SlashCommandDefinition,
    type SlashCommandInvocation,
} from "../../sources/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { recordingTracer } from "../support/recordingTracer.js";

const invocation: SlashCommandInvocation = {
    mode: {
        effort: "medium",
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
        providerId: "codex",
        serviceTier: null,
    },
};

const agents = {
    config: () => Promise.resolve({}),
} as never;

class Contributor implements SlashCommandContributor {
    readonly name: string;
    definitions: SlashCommandDefinition[];
    invocations: {
        readonly agentId: string;
        readonly input: SlashCommandInvocation;
        readonly name: string;
    }[] = [];

    constructor(name: string, definitions: SlashCommandDefinition[]) {
        this.name = name;
        this.definitions = definitions;
    }

    async slashCommands(
        _ctx: Context,
        _agentId: string,
    ): Promise<readonly SlashCommandDefinition[]> {
        return structuredClone(this.definitions);
    }

    async invokeSlashCommand(
        _ctx: Context,
        agentId: string,
        name: string,
        input: SlashCommandInvocation,
    ): Promise<void> {
        this.invocations.push({ agentId, input: structuredClone(input), name });
    }
}

describe("SlashCommandsModule", () => {
    it("traces loading stages and contributor children without changing caching or coalescing", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "slash-command-tracing-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const { tracer, spans } = recordingTracer();
            const ctx = withTracer(database.context, tracer);
            let finishDiscovery = () => {};
            const gate = new Promise<void>((resolve) => {
                finishDiscovery = resolve;
            });
            let startDiscovery = () => {};
            const entered = new Promise<void>((resolve) => {
                startDiscovery = resolve;
            });
            const owner = new Contributor("feature", [
                { description: "First.", hasArguments: false, name: "first" },
            ]);
            vi.spyOn(owner, "slashCommands").mockImplementation((ctx) =>
                ctx.span("feature.scan", async () => {
                    startDiscovery();
                    await gate;
                    return owner.definitions;
                }),
            );
            const commands = new SlashCommandsModule(events, owner);
            commands.beforeStart(ctx, agents);
            const first = commands.catalog(ctx, "agent-1");
            await entered;
            const second = commands.catalog(ctx, "agent-1");
            expect(spans[0]?.ends).toBe(0);
            finishDiscovery();
            const [left, right] = await Promise.all([first, second]);
            expect(left).toEqual(right);
            expect(owner.slashCommands).toHaveBeenCalledOnce();
            expect(spans.map((span) => span.name)).toEqual([
                "slash_commands.load",
                "slash_commands.agent_context",
                "slash_commands.contributor.feature",
                "feature.scan",
                "slash_commands.publish",
            ]);
            expect(spans[1]?.parent).toBe(spans[0]);
            expect(spans[2]?.parent).toBe(spans[0]);
            expect(spans[3]?.parent).toBe(spans[2]);
            expect(spans[4]?.parent).toBe(spans[0]);
            expect(spans.every((span) => span.ends === 1)).toBe(true);
            await commands.catalog(ctx, "agent-1");
            expect(spans).toHaveLength(5);

            spans.length = 0;
            const failure = new Error("discovery failed");
            vi.mocked(owner.slashCommands).mockRejectedValueOnce(failure);
            await expect(commands.refresh(ctx, "agent-1")).rejects.toBe(failure);
            expect(spans.map((span) => span.errors)).toEqual([[failure], [], [failure]]);
            expect(spans.every((span) => span.ends === 1)).toBe(true);
            await commands.refresh(ctx, "agent-1");
            expect(spans.filter((span) => span.name === "slash_commands.load")).toHaveLength(2);
            expect(spans.some((span) => span.name === "slash_commands.publish")).toBe(false);
        } finally {
            database.close();
        }
    });

    it("keeps image bytes private, dispatches to the owner, and emits only real changes", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "slash-command-catalog-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const origin = events.originCursor();
            const owner = new Contributor("feature", [
                {
                    description: "Review the current changes.",
                    hasArguments: true,
                    image: {
                        blob: new Uint8Array([1, 2, 3]),
                        mediaType: "image/png",
                        thumbhash: "thumbhash",
                    },
                    kind: "skill",
                    name: "review",
                },
            ]);
            const commands = new SlashCommandsModule(events, owner);
            await commands.beforeStart?.(database.context, agents);

            await expect(commands.catalog(database.context, "agent-1")).resolves.toEqual([
                {
                    description: "Review the current changes.",
                    hasArguments: true,
                    image: { thumbhash: "thumbhash" },
                    kind: "skill",
                    name: "review",
                },
            ]);
            const image = await commands.image(database.context, "agent-1", "review");
            expect(image?.mediaType).toBe("image/png");
            expect([...((image?.blob ?? new Uint8Array()) as Uint8Array)]).toEqual([1, 2, 3]);
            expect(image?.etag).toMatch(/^"[a-f0-9]{64}"$/u);
            expect(events.replay(origin)?.events.map((event) => event.type)).toEqual([
                "slash_commands.updated",
            ]);

            await commands.refresh(database.context, "agent-1");
            expect(events.replay(origin)?.events).toHaveLength(1);

            await commands.invoke(database.context, "agent-1", "review", {
                ...invocation,
                arguments: "focus on authentication",
            });
            expect(owner.invocations).toEqual([
                {
                    agentId: "agent-1",
                    input: { ...invocation, arguments: "focus on authentication" },
                    name: "review",
                },
            ]);

            owner.definitions[0] = {
                ...owner.definitions[0]!,
                image: {
                    ...owner.definitions[0]!.image!,
                    blob: new Uint8Array([4, 5, 6]),
                },
            };
            await commands.refresh(database.context, "agent-1");
            expect(events.replay(origin)?.events).toHaveLength(2);

            owner.definitions[0] = {
                ...owner.definitions[0]!,
                image: {
                    ...owner.definitions[0]!.image!,
                    mediaType: "image/webp",
                },
            };
            await commands.refresh(database.context, "agent-1");
            expect(events.replay(origin)?.events).toHaveLength(3);
        } finally {
            database.close();
        }
    });

    it("rejects duplicate names, unknown commands, and arguments on argument-free commands", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "slash-command-errors-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const compact = {
                description: "Compact context.",
                hasArguments: false,
                name: "compact",
            } satisfies SlashCommandDefinition;
            const commands = new SlashCommandsModule(
                events,
                new Contributor("one", [compact]),
                new Contributor("two", [compact]),
            );
            await commands.beforeStart?.(database.context, agents);
            await expect(commands.refresh(database.context, "agent-1")).rejects.toThrow(
                "More than one module returned the /compact command",
            );

            const valid = new SlashCommandsModule(events, new Contributor("one", [compact]));
            await valid.beforeStart?.(database.context, agents);
            await expect(
                valid.invoke(database.context, "agent-1", "missing", invocation),
            ).rejects.toBeInstanceOf(SlashCommandNotFoundError);
            await expect(
                valid.invoke(database.context, "agent-1", "compact", {
                    ...invocation,
                    arguments: "now",
                }),
            ).rejects.toBeInstanceOf(SlashCommandInputError);
        } finally {
            database.close();
        }
    });

    it("refreshes discovery from the before-turn hook", async () => {
        const events = new EventsModule();
        const database = moduleDatabase(events.migrations ?? [], "slash-command-turn-test");
        await database.ready;
        try {
            await events.beforeStart?.(database.context);
            const owner = new Contributor("feature", [
                { description: "First.", hasArguments: false, name: "first" },
            ]);
            const commands = new SlashCommandsModule(events, owner);
            const hooks = await commands.beforeStart?.(database.context, agents);
            await commands.refresh(database.context, "agent-1");
            owner.definitions = [{ description: "Second.", hasArguments: false, name: "second" }];

            await hooks?.beforeTurn?.(
                database.context,
                { agent: { id: "agent-1" } } as never,
                {} as never,
            );

            await expect(commands.catalog(database.context, "agent-1")).resolves.toMatchObject([
                { name: "second" },
            ]);
        } finally {
            database.close();
        }
    });
});
