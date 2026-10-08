import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders } from "@slopus/happy-agent-base";
import {
    CodexApiKeyCredential,
    CodexProvider,
    CodexSessionCredential,
} from "@slopus/happy-providers";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";
import { testConfigRootedAt } from "../support/configModule.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});
async function fixture(
    endpoint?: string,
    extra = "",
    credential?: CodexSessionCredential,
    smart = false,
) {
    const root = await mkdtemp(join(tmpdir(), "live-config-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const provider = new CodexProvider({
        credential: credential ?? (await CodexApiKeyCredential.tryLoad({ apiKey: "fixture-key" }))!,
        ...(endpoint === undefined ? {} : { endpoint }),
    });
    const providers = new AgentProviders();
    providers.add("voice", provider, "codex");
    const config = await testConfigRootedAt(
        root,
        `[providers.voice]\ntype="codex"\nenabled=true\n${extra}`,
        {
            inference: () => ({
                providers,
                models: [
                    {
                        id: "openai/gpt-6-astra",
                        name: "Fixture",
                        providerId: smart ? "pool" : "voice",
                        defaultEffort: "high",
                        effortLevels: ["high"],
                    },
                ],
            }),
        },
    );
    cleanups.push(() => config.closeProviders());
    return { config, provider, providers };
}
it("uses exactly the explicitly selected official account and configured-default controller", async () => {
    const f = await fixture();
    const session = vi.spyOn(f.provider, "session");
    expect(await f.config.liveCredential({ type: "openai_api_key", providerId: "voice" })).toEqual({
        type: "openai_api_key",
        token: "fixture-key",
    });
    expect(await f.config.liveControllerRoute()).toMatchObject({
        provider: f.provider,
        model: { providerId: "voice", id: "openai/gpt-6-astra", defaultEffort: "high" },
    });
    expect(session).not.toHaveBeenCalled();
});
it("freezes a smart default onto its hidden enabled account without changing the voice selection", async () => {
    const f = await fixture(
        undefined,
        'hidden=true\n[providers.pool]\ntype="smart"\nproviders=["voice"]\nenabled=true\n',
        undefined,
        true,
    );
    expect(f.config.models[0]?.providerId).toBe("pool");
    expect(await f.config.liveControllerRoute()).toMatchObject({
        provider: f.provider,
        model: { providerId: "voice", id: "openai/gpt-6-astra", defaultEffort: "high" },
    });
    expect(await f.config.liveCredential({ type: "openai_api_key", providerId: "voice" })).toEqual({
        type: "openai_api_key",
        token: "fixture-key",
    });
    await expect(
        f.config.liveCredential({ type: "codex_subscription", providerId: "pool" }),
    ).rejects.toThrow(
        "Select an individual OpenAI account for voice; account pools cannot supply voice credentials.",
    );
});
const controllerPool =
    'hidden=true\n[providers.controller]\ntype="codex"\nenabled=true\nhidden=true\n' +
    '[providers.pool]\ntype="smart"\nproviders=["controller","voice"]\nenabled=true\n';
it.each(["controller", "pool"])(
    "keeps a frozen controller on its account after refusal and observes later %s disablement",
    async (disabledProvider) => {
        const f = await fixture(undefined, controllerPool, undefined, true);
        const controller = new ScriptedProvider([
            [{ type: "done", state: "error", kind: "unknown", message: "Signed out." }],
            (ctx) =>
                (async function* () {
                    expect(ctx.lifetime?.aborted).toBe(true);
                    yield { type: "done", state: "cancelled" } as const;
                })(),
        ]);
        f.providers.add("controller", controller, "codex");
        vi.spyOn(Math, "random").mockReturnValue(0);
        const other = vi.spyOn(f.provider, "session");
        const route = await f.config.liveControllerRoute();
        expect(route.signal?.aborted).toBe(false);
        expect(route.provider).toBe(controller);
        expect(route.model).toMatchObject({ providerId: "controller", defaultEffort: "high" });
        const session = await route.provider.session("frozen-controller", {
            instructions: "",
            tools: [],
        });
        const request = { model: route.model.id, context: { instructions: "", messages: [] } };
        try {
            const first = [];
            for await (const event of session.run(
                withLifetime(createRootContext(), route.signal!),
                request,
            ))
                first.push(event);
            expect(first.at(-1)).toMatchObject({ state: "error", message: "Signed out." });
            f.config.setProviderEnabled(disabledProvider, false);
            expect(route.signal?.aborted).toBe(true);
            const disabled = [];
            for await (const event of session.run(
                withLifetime(createRootContext(), route.signal!),
                request,
            ))
                disabled.push(event);
            expect(disabled.at(-1)).toMatchObject({ state: "cancelled" });
            expect(f.config.isProviderEnabled("voice")).toBe(true);
            expect(other).not.toHaveBeenCalled();
        } finally {
            await session.destroy();
        }
    },
);
it("does not try another pool credential when its selected controller cannot load", async () => {
    const f = await fixture(undefined, controllerPool, undefined, true);
    f.providers.add(
        "controller",
        async () => {
            throw new Error("The selected controller is signed out.");
        },
        "codex",
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const other = vi.spyOn(f.provider, "session");
    await expect(f.config.liveControllerRoute()).rejects.toThrow(
        "selected controller is signed out",
    );
    expect(other).not.toHaveBeenCalled();
});
it("reloads the selected native credential once without refreshing or changing accounts", async () => {
    const credential = CodexSessionCredential.fromAuth(
        { accessToken: "old", accountId: "fixture" },
        { authFile: "/unused-live-fixture" },
    );
    const current = CodexSessionCredential.fromAuth(
        { accessToken: "current", accountId: "fixture" },
        { authFile: "/unused-live-fixture" },
    );
    const reload = vi.spyOn(credential, "reloadForUnauthorized").mockResolvedValue(current);
    const refresh = vi.spyOn(credential, "refreshForUnauthorized");
    const f = await fixture(undefined, "", credential);
    expect(
        await f.config.liveCredential({ type: "codex_subscription", providerId: "voice" }),
    ).toEqual({ type: "codex_subscription", token: "current", accountId: "fixture" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
});
it.each([
    "https://proxy.example/v1",
    "https://user:password@api.openai.com/v1",
    "http://api.openai.com/v1",
])("never forwards a custom-origin credential from %s to OpenAI Live", async (endpoint) => {
    const f = await fixture(endpoint);
    await expect(
        f.config.liveCredential({ type: "openai_api_key", providerId: "voice" }),
    ).rejects.toThrow("official OpenAI");
});
it("refuses credential-kind mismatches and disabled accounts without fallback", async () => {
    const f = await fixture();
    await expect(
        f.config.liveCredential({ type: "codex_subscription", providerId: "voice" }),
    ).rejects.toThrow();
    f.config.setProviderEnabled("voice", false);
    await expect(
        f.config.liveCredential({ type: "openai_api_key", providerId: "voice" }),
    ).rejects.toThrow();
    await expect(f.config.liveControllerRoute()).rejects.toThrow("enabled default model");
});
