import { describe, expect, it } from "vitest";
import { GrokProvider } from "@slopus/rig-providers";
import type { Executor } from "@slopus/rig-execution";

import { createNodeAgentContext, type PermissionMode } from "../agent/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createExecutor } from "./createExecutor.js";
import type { HostedCapability } from "@slopus/rig-execution";

/**
 * The searches Grok would declare on a request built right now.
 *
 * One executor owns every configured provider and survives a model switch and a permission
 * change, so this deliberately reaches through the built provider rather than re-deriving the
 * answer: what the request will carry is the only thing worth asserting.
 */
async function grokSearchesOnNextRequest(options: {
    isSubagent?: boolean;
    permissionMode: PermissionMode;
    /** When set, the mode the session owns, which the executor must read instead of a context. */
    sessionOwnsMode?: boolean;
    startOn?: "claude" | "grok";
}): Promise<{
    codexSearches: () => readonly string[];
    executor: Executor;
    isolatedSearches: () => Promise<readonly string[]>;
    mode: (next: PermissionMode) => void;
    searches: () => readonly string[];
}> {
    let sessionMode = options.permissionMode;
    const context = createNodeAgentContext({
        cwd: "/tmp/rig-executor-hosted-search",
        permissionMode: options.permissionMode,
        processManager: new NativeProcessManager(),
    });
    const result = createExecutor({
        agentContext: context,
        apiKey: "test-api-key",
        env: { XAI_API_KEY: "test-api-key" },
        providers: {
            claude: { enabled: true, type: "claude" },
            codex: { enabled: true, type: "codex" },
            grok: { enabled: true, type: "grok" },
        },
        ...(options.sessionOwnsMode === true ? { resolvePermissionMode: () => sessionMode } : {}),
        sessionId: "session-1",
    });
    const executor = result.executor;
    if (executor === undefined) throw new Error("The executor was not built.");
    // Selecting a provider is what a model switch does; the executor and its providers are the
    // same objects either way.
    executor.selectProvider(options.startOn ?? "grok");
    const grok = async (from: Executor): Promise<GrokProvider> => {
        const definition = from.providers.find((provider) => provider.id === "grok");
        if (typeof definition?.native !== "function") throw new Error("Grok resolves lazily.");
        return (await definition.native({} as never)) as GrokProvider;
    };
    const provider = await grok(executor);
    const codexDefinition = executor.providers.find((candidate) => candidate.id === "codex");
    if (typeof codexDefinition?.native !== "function") throw new Error("Codex resolves lazily.");
    const codex = (await codexDefinition.native({} as never)) as unknown as {
        hostedTools?: () => readonly { name: string }[];
    };
    return {
        codexSearches: () => (codex.hostedTools?.() ?? []).map((tool) => tool.name),
        executor,
        isolatedSearches: async () =>
            ((await grok(executor.isolate("auto-reviewer"))).hostedTools?.() ?? []).map(
                (tool) => tool.name,
            ),
        mode: (next) => {
            sessionMode = next;
            // Left stale on purpose when the session owns the mode: that is the real shape of the
            // problem, where the context this executor captured has already been replaced and no
            // later change will ever reach it.
            if (options.sessionOwnsMode !== true) context.permissions?.setMode(next);
        },
        searches: () => (provider.hostedTools?.() ?? []).map((tool) => tool.name),
    };
}

describe("createExecutor", () => {
    it("creates one executor containing every enabled configured provider", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext({
                cwd: "/tmp/rig-executor-test",
                processManager: new NativeProcessManager(),
            }),
            apiKey: "test-api-key",
            env: {},
            providers: {
                codex: { enabled: true, type: "codex" },
                disabled_claude: { enabled: false, type: "claude" },
                grok: { enabled: true, type: "grok" },
            },
            sessionId: "session-1",
        });

        expect(result.executor?.providers.map((provider) => provider.id)).toEqual([
            "codex",
            "grok",
        ]);
        expect(result.missingCredentials).toEqual(new Map());
        expect(result.executor?.profiles.map((profile) => profile.id)).toEqual(
            expect.arrayContaining(["openai/gpt-5.6-sol", "xai/grok-build"]),
        );
        expect(result.executor?.environment).toMatchObject({
            osVersion: expect.any(String),
            platform: process.platform,
            primaryWorkingDirectory: "/tmp/rig-executor-test",
            shell: "",
        });

        result.executor?.selectProvider("grok");
        expect(result.executor?.id).toBe("grok");
        expect(result.executor?.models.map((model) => model.id)).toContain("xai/grok-build");
    });

    it("gives a root Grok agent its searches in the modes that reach the network", async () => {
        for (const permissionMode of ["auto", "full_access"] as const) {
            const grok = await grokSearchesOnNextRequest({ permissionMode });
            expect(grok.searches()).toEqual(["web_search", "x_search"]);
        }
    });

    it("gives a root Grok agent none in the modes that do not", async () => {
        for (const permissionMode of ["read_only", "workspace_write"] as const) {
            const grok = await grokSearchesOnNextRequest({ permissionMode });
            expect(grok.searches()).toEqual([]);
        }
    });

    // The executor is built once and reused for the rest of the session. A narrow starting mode
    // must not erase what the agent holds, or widening back to Auto would return an agent that
    // silently can no longer search.
    it("returns a root Grok agent's searches when a narrow mode later widens", async () => {
        const grok = await grokSearchesOnNextRequest({ permissionMode: "read_only" });
        expect(grok.searches()).toEqual([]);

        grok.mode("auto");
        expect(grok.searches()).toEqual(["web_search", "x_search"]);

        grok.mode("workspace_write");
        expect(grok.searches()).toEqual([]);
    });

    // The same executor holds every configured provider, so what Grok declares cannot depend on
    // which provider happened to be selected when it was built.
    it("gives Grok its searches even when the session started on another provider", async () => {
        const grok = await grokSearchesOnNextRequest({
            permissionMode: "auto",
            startOn: "claude",
        });
        expect(grok.searches()).toEqual(["web_search", "x_search"]);
    });

    // OpenAI runs a search inside its own response the way xAI does, so the same decision reaches
    // it: the provider a person chose is the backend they chose along with it.
    it("gives a root Codex agent the web search its backend runs", async () => {
        const auto = await grokSearchesOnNextRequest({ permissionMode: "auto" });
        expect(auto.codexSearches()).toEqual(["web_search"]);

        const narrow = await grokSearchesOnNextRequest({ permissionMode: "workspace_write" });
        expect(narrow.codexSearches()).toEqual([]);
    });

    // OpenAI has no X search, so asking the same question of Codex must not invent one: the model
    // would be told about a tool that answers nothing.
    it("declares to each provider only what its own backend runs", async () => {
        const auto = await grokSearchesOnNextRequest({ permissionMode: "auto" });

        expect(auto.searches()).toEqual(["web_search", "x_search"]);
        expect(auto.codexSearches()).toEqual(["web_search"]);
    });

    // A subagent is not a special case. It used to hold only what a spawn granted it; the mode
    // decides now, and the mode is the same question for every agent in the tree.
    it("gives a subagent what its provider runs, exactly as a root agent gets it", async () => {
        const subagent = await grokSearchesOnNextRequest({
            isSubagent: true,
            permissionMode: "auto",
        });

        expect(subagent.searches()).toEqual(["web_search", "x_search"]);
    });

    it("withholds a subagent's search in a mode that cannot reach the network", async () => {
        const grok = await grokSearchesOnNextRequest({
            isSubagent: true,
            permissionMode: "workspace_write",
            sessionOwnsMode: true,
        });
        expect(grok.searches()).toEqual([]);

        grok.mode("auto");
        expect(grok.searches()).toEqual(["web_search", "x_search"]);
    });

    // Switching to an incompatible model keeps this executor and throws away the agent context it
    // was built with. Every later permission change lands on the replacement, so a gate that read
    // the original would report Auto forever and Read only would quietly stop taking search away.
    it("reads the session's own mode rather than the context it was built with", async () => {
        const grok = await grokSearchesOnNextRequest({
            permissionMode: "auto",
            sessionOwnsMode: true,
        });
        expect(grok.searches()).toEqual(["web_search", "x_search"]);

        grok.mode("read_only");
        expect(grok.searches()).toEqual([]);
    });

    // An isolate runs an auxiliary query the person never asked for and never sees — the Auto
    // permission reviewer is one, and what it reads is exactly the untrusted material a review
    // exists to judge. A search it could run would leave no trace anywhere.
    it("lends no provider-run search to an isolate", async () => {
        const grok = await grokSearchesOnNextRequest({ permissionMode: "full_access" });
        expect(grok.searches()).toEqual(["web_search", "x_search"]);
        expect(await grok.isolatedSearches()).toEqual([]);
    });
});
