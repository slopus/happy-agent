import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders } from "@slopus/happy-agent-base";
import {
    CodexApiKeyCredential,
    CodexProvider,
    CodexSessionCredential,
} from "@slopus/happy-providers";
import { afterEach, expect, it, vi } from "vitest";
import { testConfigRootedAt } from "../support/configModule.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});
async function fixture(endpoint?: string, extra = "", credential?: CodexSessionCredential) {
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
            inference: {
                providers,
                models: [
                    {
                        id: "openai/gpt-6-astra",
                        name: "Fixture",
                        providerId: "voice",
                        defaultEffort: "high",
                        effortLevels: ["high"],
                    },
                ],
            },
        },
    );
    cleanups.push(() => config.closeProviders());
    return { config, provider };
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
