import {
    AgentKV,
    type AgentModel,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterAll, describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { ConfigModule } from "../../sources/config/ConfigModule.js";
import { GitModule } from "../../sources/git/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { TitlesModule } from "../../sources/titles/TitlesModule.js";
import { WorkspacesModule } from "../../sources/workspaces/WorkspacesModule.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { providersOf, sharedKV, textTurn } from "../support/fixtures.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { primaryAgents, resolveModuleHooks } from "../support/moduleHooks.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { projectsModuleFor } from "../support/projectsModule.js";

const ctx = createRootContext().named("happy-agent-modules-titles");
const lifecycleDatabase = moduleDatabase([], "happy-agent-modules-titles-lifecycle");

afterAll(() => lifecycleDatabase.close());

/** A catalog served by the one scripted account, cheapest model last so preference is visible. */
function models(
    ids: readonly string[] = ["openai/gpt-5.6-max", "anthropic/sonnet-5"],
): AgentModel[] {
    return ids.map((id) => ({
        providerId: "scripted",
        id,
        name: id,
        effortLevels: ["off", "medium", "high"],
        defaultEffort: "medium",
    })) as AgentModel[];
}

/**
 * A configuration whose accounts are scripted, read from a Happy root of its own.
 *
 * Naming takes the accounts and the catalog from the configuration module, so a test that scripts
 * inference scripts it there — exactly where the product's own test seam puts it.
 */
async function scriptedConfig(
    provider: ScriptedProvider,
    catalog: AgentModel[],
): Promise<ConfigModule> {
    return await temporaryTestConfig(undefined, {
        inference: { models: catalog, providers: providersOf(provider) },
    });
}

async function titles(script: SessionEvent[][], catalog: AgentModel[] = models()) {
    const provider = new ScriptedProvider(script);
    const config = await scriptedConfig(provider, catalog);
    const git = new GitModule();
    // A chat outside a workspace never reaches the catalog, and one inside it is exercised where a
    // real project and a real worktree exist, so the catalog here is simply the empty one this
    // configuration's own roots describe.
    const workspaces = new WorkspacesModule(
        config,
        projectsModuleFor(config, git),
        git,
        new AbortModule(new ComputeModule(config, new SecretsModule())),
        new DurableFunctionsModule(),
    );
    const module = new TitlesModule(config, new HistoryModule(), workspaces);
    return { module, provider };
}

/**
 * A module started the way a collection starts it, holding the store its agents share.
 *
 * Everything the module remembers between chats lives in that store, so a test that asks what it
 * remembers has to hand it one first, exactly as the first agent to be created does.
 */
async function started(): Promise<TitlesModule> {
    const { module } = await titles([]);
    const hooks = await resolveModuleHooks(lifecycleDatabase.context, module, primaryAgents());
    await hooks.agentCreatedTransact?.(
        ctx,
        { agents: primaryAgents(), sharedKV: sharedKV() },
        { id: "agent-1", metadata: undefined },
    );
    return module;
}

/** The chat title alone, which is all a chat outside a workspace asks for. */
async function nameChat(
    module: TitlesModule,
    request: { readonly firstMessage: string; readonly providerId?: string },
): Promise<string | undefined> {
    const names = await module.suggestNames(ctx, {
        firstMessage: request.firstMessage,
        wanted: { title: true },
        ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
    });
    return names.title;
}

describe("TitlesModule naming", () => {
    it("names a chat on the cheapest model of its own account, outside the chat's own session", async () => {
        const test = await titles([textTurn("<title>Retry policy rewrite</title>")]);

        const title = await nameChat(test.module, {
            firstMessage: "Rewrite how the outer loop retries provider requests.",
            providerId: "scripted",
        });

        expect(title).toBe("Retry policy rewrite");
        const session = test.provider.sessions[0]!;
        expect(session.id.startsWith("naming:")).toBe(true);
        expect(session.options.tools).toEqual([]);
        expect(session.options.inferenceMaxRetries).toBe(0);
        const request = session.requests[0]!;
        expect(request.model).toBe("anthropic/sonnet-5");
        expect(request.effort).toBe("off");
        expect(JSON.stringify(request.context.messages)).toContain("outer loop retries");
    });

    it("reads the name out of an answer wrapped in whatever else the model wrote", async () => {
        const test = await titles([
            textTurn(
                "Sure! Here you go:\n\n<title>Retry policy rewrite</title>\n\nHope that helps.",
            ),
        ]);

        await expect(nameChat(test.module, { firstMessage: "rewrite retries" })).resolves.toBe(
            "Retry policy rewrite",
        );
    });

    it("takes an untagged answer as the name rather than losing it", async () => {
        const test = await titles([textTurn("Retry policy rewrite")]);

        await expect(nameChat(test.module, { firstMessage: "rewrite retries" })).resolves.toBe(
            "Retry policy rewrite",
        );
    });

    it("bounds a chat title to six words", async () => {
        const test = await titles([
            textTurn("<title>one two three four five six seven eight</title>"),
        ]);

        await expect(nameChat(test.module, { firstMessage: "anything" })).resolves.toBe(
            "one two three four five six",
        );
    });

    it("asks for the title and the slug together, in one request", async () => {
        const test = await titles([
            textTurn("<title>Retry policy rewrite</title>\n<slug>retry-policy-rewrite</slug>"),
        ]);

        await expect(
            test.module.suggestNames(ctx, {
                firstMessage: "rewrite retries",
                wanted: { slug: true, title: true },
            }),
        ).resolves.toEqual({ slug: "retry-policy-rewrite", title: "Retry policy rewrite" });
        // Both names describe one subject, so a caller asking for both pays one round trip.
        expect(test.provider.sessions).toHaveLength(1);
    });

    it("reduces a slug the model wrote as a title to kebab-case", async () => {
        const test = await titles([textTurn("<slug>Retry Policy Rewrite</slug>")]);

        await expect(
            test.module.suggestNames(ctx, {
                firstMessage: "rewrite retries",
                wanted: { slug: true },
            }),
        ).resolves.toEqual({ slug: "retry-policy-rewrite" });
    });

    it("asks only for what is still wanted, and reads an untagged answer as that one name", async () => {
        const test = await titles([textTurn("retry-policy-rewrite")]);

        await expect(
            test.module.suggestNames(ctx, {
                firstMessage: "rewrite retries",
                wanted: { slug: true },
            }),
        ).resolves.toEqual({ slug: "retry-policy-rewrite" });
        const sent = JSON.stringify(test.provider.sessions[0]!.requests[0]);
        expect(sent).toContain("<slug>");
        expect(sent).not.toContain("<title>");
    });

    it("keeps an untagged answer out of two names it cannot be split into", async () => {
        const test = await titles([textTurn("Retry policy rewrite")]);

        await expect(
            test.module.suggestNames(ctx, {
                firstMessage: "rewrite retries",
                wanted: { slug: true, title: true },
            }),
        ).resolves.toEqual({});
    });

    it("asks nothing when no name is wanted", async () => {
        const test = await titles([textTurn("<title>Something</title>")]);

        await expect(
            test.module.suggestNames(ctx, { firstMessage: "rewrite retries", wanted: {} }),
        ).resolves.toEqual({});
        expect(test.provider.sessions).toHaveLength(0);
    });

    it("answers with no name rather than a bad one when the model says nothing usable", async () => {
        const test = await titles([textTurn("<title>   </title>")]);

        await expect(
            nameChat(test.module, { firstMessage: "rewrite retries" }),
        ).resolves.toBeUndefined();
    });

    it("does not name anything from an empty first message", async () => {
        const test = await titles([textTurn("<title>Something</title>")]);

        await expect(nameChat(test.module, { firstMessage: "   " })).resolves.toBeUndefined();
        expect(test.provider.sessions).toHaveLength(0);
    });

    it("falls back to the configured account when the chat has named none", async () => {
        const test = await titles([textTurn("<title>Retry policy rewrite</title>")]);

        await expect(
            nameChat(test.module, { firstMessage: "rewrite retries", providerId: "gone" }),
        ).resolves.toBe("Retry policy rewrite");
        expect(test.provider.sessions[0]!.requests[0]!.model).toBe("anthropic/sonnet-5");
    });

    it("names nothing at all when the catalog is empty", async () => {
        const test = await titles([textTurn("<title>Retry policy rewrite</title>")], []);

        await expect(
            nameChat(test.module, { firstMessage: "rewrite retries" }),
        ).resolves.toBeUndefined();
        expect(test.provider.sessions).toHaveLength(0);
    });

    it("reports a provider failure to its caller instead of inventing a name", async () => {
        const test = await titles([
            [
                {
                    type: "done",
                    state: "error",
                    kind: "unknown",
                    message: "That account is signed out.",
                },
            ],
        ]);

        await expect(nameChat(test.module, { firstMessage: "rewrite retries" })).rejects.toThrow(
            "That account is signed out.",
        );
    });
});

describe("TitlesModule user-message lifecycle", () => {
    it("uses an unstamped user message and ignores a system message before it", async () => {
        const test = await titles([textTurn("<title>Retry policy rewrite</title>")]);
        let metadata: Record<string, unknown> = {};
        const agents = {
            config: () => Promise.resolve({ metadata }),
            updateMetadata: (_ctx: unknown, _agentId: string, update: Record<string, unknown>) => {
                metadata = { ...metadata, ...update };
                return Promise.resolve();
            },
        } as unknown as AgentSystemRef;
        const hooks = await resolveModuleHooks(lifecycleDatabase.context, test.module, agents);
        const persistence = new InMemoryPersistence();
        const scope = {
            agent: {
                id: "unstamped-user-title",
                metadata: undefined,
                provider: "scripted",
            },
            historyKV: new AgentKV(persistence, "history."),
            kv: new AgentKV(persistence, "agent."),
            runKV: new AgentKV(persistence, "run."),
            sharedKV: new AgentKV(persistence, "shared."),
        } as AgentModuleScope;

        await lifecycleDatabase.context.inTx(async (txCtx) => {
            await hooks.messageAcceptedTransact?.(txCtx, scope, {
                id: "system-message",
                kind: "send",
                message: {
                    role: "system",
                    content: [{ type: "text", text: "Internal wake-up" }],
                },
                profile: null,
            });
        });
        await lifecycleDatabase.context.inTx(async (txCtx) => {
            await hooks.messageAcceptedTransact?.(txCtx, scope, {
                id: "user-message",
                kind: "send",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "Rewrite the retry policy." }],
                },
                profile: null,
            });
        });
        await vi.waitFor(() => expect(metadata["title"]).toBe("Retry policy rewrite"));
        await test.module.close();

        expect(test.provider.sessions).toHaveLength(1);
        expect(JSON.stringify(test.provider.sessions[0]?.requests[0])).toContain(
            "Rewrite the retry policy.",
        );
        expect(JSON.stringify(test.provider.sessions[0]?.requests[0])).not.toContain(
            "Internal wake-up",
        );
    });

    it("never generates over or refines a title chosen before the conversation", async () => {
        const test = await titles([textTurn("<title>A model replacement</title>")]);
        const metadata: Record<string, unknown> = { title: "Deliberate title" };
        const agents = {
            config: () => Promise.resolve({ metadata }),
            updateMetadata: vi.fn(() => Promise.resolve()),
        } as unknown as AgentSystemRef;
        const hooks = await resolveModuleHooks(lifecycleDatabase.context, test.module, agents);
        const persistence = new InMemoryPersistence();
        const scope = {
            agent: {
                id: "deliberately-titled-agent",
                metadata,
                provider: "scripted",
            },
            historyKV: new AgentKV(persistence, "history."),
            kv: new AgentKV(persistence, "agent."),
            runKV: new AgentKV(persistence, "run."),
            sharedKV: new AgentKV(persistence, "shared."),
        } as AgentModuleScope;

        for (const [id, text] of [
            ["first-user-message", "Investigate the retry policy."],
            ["second-user-message", "Now rewrite it."],
        ] as const) {
            await lifecycleDatabase.context.inTx(async (txCtx) => {
                await hooks.messageAcceptedTransact?.(txCtx, scope, {
                    id,
                    kind: "send",
                    message: { role: "user", content: [{ type: "text", text }] },
                    profile: null,
                });
            });
        }
        await test.module.close();

        expect(test.provider.sessions).toHaveLength(0);
        expect(agents.updateMetadata).not.toHaveBeenCalled();
        expect(metadata["title"]).toBe("Deliberate title");
    });
});

describe("TitlesModule naming from a first message", () => {
    it("names a chat that works in no workspace, and asks for no slug it cannot use", async () => {
        const test = await titles([textTurn("<title>Retry policy rewrite</title>")]);

        await expect(
            test.module.nameFromFirstMessage(ctx, {
                firstMessage: "Rewrite how the outer loop retries provider requests.",
            }),
        ).resolves.toEqual({ title: "Retry policy rewrite" });
        const sent = JSON.stringify(test.provider.sessions[0]!.requests[0]);
        expect(sent).not.toContain("<slug>");
    });

    it("leaves a chat a person has already named alone", async () => {
        const test = await titles([textTurn("<title>Something a model invented</title>")]);

        await expect(
            test.module.nameFromFirstMessage(ctx, {
                firstMessage: "The login page redirects in a loop.",
                sessionNamed: true,
            }),
        ).resolves.toEqual({});
        expect(test.provider.sessions).toHaveLength(0);
    });

    it("names nothing from an empty first message", async () => {
        const test = await titles([textTurn("<title>Something</title>")]);

        await expect(
            test.module.nameFromFirstMessage(ctx, { firstMessage: "   " }),
        ).resolves.toEqual({});
        expect(test.provider.sessions).toHaveLength(0);
    });

    it("never fails the message it is naming", async () => {
        const test = await titles([
            [{ type: "done", state: "error", kind: "unknown", message: "Signed out." }],
        ]);

        await expect(
            test.module.nameFromFirstMessage(ctx, { firstMessage: "rewrite retries" }),
        ).resolves.toEqual({});
    });
});

describe("TitlesModule second look at a title", () => {
    it("reads the conversation on the cheapest model and answers with a better title", async () => {
        const test = await titles([textTurn("<title>Retry policy rewrite</title>")]);

        const title = await test.module.refineChat(ctx, {
            currentTitle: "Flaky provider request",
            providerId: "scripted",
            transcript: "User: this keeps failing\nAssistant: the outer loop retries too eagerly",
        });

        expect(title).toBe("Retry policy rewrite");
        const session = test.provider.sessions[0]!;
        expect(session.id.startsWith("naming:")).toBe(true);
        expect(session.options.tools).toEqual([]);
        const request = session.requests[0]!;
        expect(request.model).toBe("anthropic/sonnet-5");
        expect(request.effort).toBe("off");
        const sent = JSON.stringify(request.context.messages);
        expect(sent).toContain("Flaky provider request");
        expect(sent).toContain("retries too eagerly");
    });

    it("gives back the title it was shown when the conversation has not contradicted it", async () => {
        const test = await titles([textTurn("<title>Flaky provider request</title>")]);

        await expect(
            test.module.refineChat(ctx, {
                currentTitle: "Flaky provider request",
                transcript: "User: this keeps failing\nAssistant: it does",
            }),
        ).resolves.toBe("Flaky provider request");
    });

    it("looks at nothing when there is no conversation to look at", async () => {
        const test = await titles([textTurn("<title>Something</title>")]);

        await expect(test.module.refineChat(ctx, { transcript: "   " })).resolves.toBeUndefined();
        expect(test.provider.sessions).toHaveLength(0);
    });
});

describe("TitlesModule workspace naming record", () => {
    it("remembers that a workspace has taken the name of a chat, once", async () => {
        const module = await started();

        await expect(module.workspaceWasNamed(ctx, "ws-1")).resolves.toBe(false);

        await module.markWorkspaceNamed(ctx, "ws-1");
        await module.markWorkspaceNamed(ctx, "ws-1");

        await expect(module.workspaceWasNamed(ctx, "ws-1")).resolves.toBe(true);
        await expect(module.workspaceWasNamed(ctx, "ws-2")).resolves.toBe(false);
    });
});
