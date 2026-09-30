import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, CodexSessionCredential } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];
const configs: ConfigModule[] = [];
const ctx = createRootContext().named("service-tier-test");
const ASTRA = "openai/gpt-6-astra";
const SOL = "openai/gpt-6-sol";

afterEach(async () => {
    for (const config of configs.splice(0)) config.closeProviders();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("account-scoped Codex service tiers", () => {
    it("starts one background pass after startup, repeats each minute, and stops on shutdown", async () => {
        const { config } = await fixture();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.spyOn(config, "refreshProviderCredentials").mockResolvedValue();
        const refresh = vi.spyOn(config, "refreshProviderServiceTiers").mockResolvedValue();
        await config.beforeStart().afterStart?.(ctx, {} as never);
        await config.beforeStart().afterStart?.(ctx, {} as never);
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        config.closeProviders();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a capability reply delivered after shutdown", async () => {
        const { config, providers } = await fixture();
        let finish!: (value: Readonly<Record<string, readonly string[]>>) => void;
        providers.first.modelServiceTiers.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const pass = config.refreshProviderServiceTiers(ctx);
        await vi.waitFor(() => expect(providers.first.modelServiceTiers).toHaveBeenCalledOnce());
        const signal = providers.first.modelServiceTiers.mock.calls[0]?.[1]?.signal;
        config.closeProviders();
        expect(signal?.aborted).toBe(true);
        finish({ [ASTRA]: ["ultrafast"] });
        await pass;
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
    });

    it("notifies clients on capability changes but preserves selection through unchanged refreshes", async () => {
        const { config, firstFile } = await fixture();
        vi.useFakeTimers({ toFake: ["Date"] });
        const changed = vi.fn();
        const unsubscribe = config.onProviderServiceTiersChanged(changed);
        await config.refreshProviderServiceTiers(ctx);
        expect(changed).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(4 * 60_000);
        await config.refreshProviderServiceTiers(ctx);
        expect(changed).toHaveBeenCalledOnce();
        await writeFile(firstFile, "changed account");
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        expect(changed).toHaveBeenCalledTimes(2);
        unsubscribe();
        await config.refreshProviderServiceTiers(ctx);
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it("keeps models curated and grants Ultrafast only to the advertised account/model", async () => {
        const { config, providers } = await fixture();
        const before = config.catalog.map(({ providerId, id }) => `${providerId}/${id}`);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        await config.refreshProviderServiceTiers(ctx);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority", "ultrafast"]);
        expect(tiers(config, "first", SOL)).toEqual(["priority"]);
        expect(tiers(config, "second", ASTRA)).toEqual(["priority"]);
        expect(tiers(config, "smart", ASTRA)).toEqual(["priority"]);
        expect(
            config.models.find((model) => model.providerId === "first" && model.id === ASTRA)
                ?.serviceTiers,
        ).toEqual(["priority", "ultrafast"]);
        expect(config.catalog.map(({ providerId, id }) => `${providerId}/${id}`)).toEqual(before);
        expect(providers.first.modelServiceTiers.mock.calls[0]?.[0]).toContain(ASTRA);
        expect(providers.first.modelServiceTiers.mock.calls[0]?.[0]).not.toContain(
            "unlisted/model",
        );
    });

    it("expires stale eligibility, clears failures, and can recover", async () => {
        const { config, providers } = await fixture();
        vi.useFakeTimers({ toFake: ["Date"] });
        await config.refreshProviderServiceTiers(ctx);
        vi.advanceTimersByTime(5 * 60_000);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        providers.first.modelServiceTiers.mockRejectedValueOnce(new Error("secret diagnostics"));
        await expect(config.refreshProviderServiceTiers(ctx)).resolves.toBeUndefined();
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        await config.refreshProviderServiceTiers(ctx);
        expect(tiers(config, "first", ASTRA)).toContain("ultrafast");
    });

    it("clears eligibility when the configured provider can no longer be resolved", async () => {
        const { config } = await fixture();
        await config.refreshProviderServiceTiers(ctx);
        vi.mocked(config.resolveProviderUnchecked).mockResolvedValue(null);
        await config.refreshProviderServiceTiers(ctx);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
    });

    it("invalidates immediately when an explicit account file changes or disappears", async () => {
        const { config, providers, firstFile } = await fixture();
        await config.refreshProviderServiceTiers(ctx);
        await writeFile(firstFile, "different account credentials");
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        providers.first.serviceTierAccountKey.mockResolvedValue(null);
        await config.refreshProviderServiceTiers(ctx);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        await rm(firstFile);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
    });

    it("does not publish a result whose account changed during the request", async () => {
        const { config, providers } = await fixture();
        providers.first.serviceTierAccountKey
            .mockResolvedValueOnce("account-a")
            .mockResolvedValue("account-b");
        await config.refreshProviderServiceTiers(ctx);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
    });

    it("reuses account capabilities across reconstructed providers but rejects sessions of the previous account", async () => {
        const { config, providers, firstFile } = await fixture();
        await config.refreshProviderServiceTiers(ctx);
        const sameAccount = provider(firstFile, "first-account", {});
        vi.mocked(config.resolveProviderUnchecked).mockImplementation(async (id) =>
            id === "first" ? sameAccount : providers.second,
        );
        await config.refreshProviderServiceTiers(ctx);
        expect(sameAccount.modelServiceTiers).not.toHaveBeenCalled();
        await expect(
            config.validateProviderServiceTier("first", ASTRA, "ultrafast", sameAccount),
        ).resolves.toBeUndefined();
        const oldSessionProvider = provider(firstFile, "old-account", {});
        oldSessionProvider.serviceTierAccountKey.mockResolvedValue(null);
        await expect(
            config.validateProviderServiceTier("first", ASTRA, "ultrafast", oldSessionProvider),
        ).rejects.toThrow("Ultrafast");
    });

    it("validates restored Ultrafast requests locally without a network refresh", async () => {
        const { config, providers } = await fixture();
        await expect(
            config.validateProviderServiceTier("first", ASTRA, "ultrafast"),
        ).rejects.toThrow("Ultrafast");
        await config.refreshProviderServiceTiers(ctx);
        await expect(
            config.validateProviderServiceTier("first", ASTRA, "ultrafast"),
        ).resolves.toBeUndefined();
        await expect(
            config.validateProviderServiceTier("second", ASTRA, "ultrafast"),
        ).rejects.toThrow("Ultrafast");
        await expect(config.validateProviderServiceTier("first", SOL, "ultrafast")).rejects.toThrow(
            "Ultrafast",
        );
        providers.first.serviceTierAccountKey.mockResolvedValue("rotated-token");
        await expect(
            config.validateProviderServiceTier("first", ASTRA, "ultrafast"),
        ).rejects.toThrow("Ultrafast");
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        await expect(
            config.validateProviderServiceTier("first", ASTRA, "priority"),
        ).resolves.toBeUndefined();
        await expect(
            config.validateProviderServiceTier("first", ASTRA, undefined),
        ).resolves.toBeUndefined();
        expect(providers.first.modelServiceTiers).toHaveBeenCalledOnce();
    });

    it("does not overlap refresh passes and clears disabled accounts", async () => {
        const { config, providers } = await fixture();
        let finish!: (value: Readonly<Record<string, readonly string[]>>) => void;
        providers.first.modelServiceTiers.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const first = config.refreshProviderServiceTiers(ctx);
        const second = config.refreshProviderServiceTiers(ctx);
        await vi.waitFor(() => expect(providers.first.modelServiceTiers).toHaveBeenCalledOnce());
        config.setProviderEnabled("first", false);
        finish({ [ASTRA]: ["ultrafast"] });
        await Promise.all([first, second]);
        expect(tiers(config, "first", ASTRA)).toEqual(["priority"]);
        expect(providers.first.modelServiceTiers).toHaveBeenCalledOnce();
    });
});

function tiers(config: ConfigModule, providerId: string, modelId: string) {
    return config.catalog.find((model) => model.providerId === providerId && model.id === modelId)
        ?.serviceTiers;
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "happy-service-tiers-"));
    roots.push(root);
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    const firstFile = join(root, "first.json");
    const secondFile = join(root, "second.json");
    await writeFile(firstFile, "first credential");
    await writeFile(secondFile, "second credential");
    await writeFile(
        join(directory, "happy.toml"),
        [
            "[providers]",
            "default_enable = false",
            ...[
                ["first", firstFile],
                ["second", secondFile],
            ].flatMap(([id, file]) => [
                `[providers.${id}]`,
                'type = "codex"',
                "enabled = true",
                "credential_isolation = true",
                `auth_file = ${JSON.stringify(file)}`,
            ]),
            "[providers.smart]",
            'type = "smart"',
            "enabled = true",
            'providers = ["first", "second"]',
        ].join("\n"),
    );
    const config = await ConfigModule.load(join(root, ".happy"));
    configs.push(config);
    const providers = {
        first: provider(firstFile, "first-account", {
            [ASTRA]: ["ultrafast"],
            "unlisted/model": ["ultrafast"],
        }),
        second: provider(secondFile, "second-account", {}),
    };
    vi.spyOn(config, "resolveProviderUnchecked").mockImplementation(async (id) =>
        id === "first" ? providers.first : providers.second,
    );
    return { config, providers, firstFile };
}

function provider(
    authFile: string,
    account: string,
    tiers: Readonly<Record<string, readonly string[]>>,
) {
    return Object.assign(
        new CodexProvider({
            credential: CodexSessionCredential.fromAuth({ accessToken: "fixture" }, { authFile }),
        }),
        {
            serviceTierAccountKey: vi.fn(async (): Promise<string | null> => account),
            modelServiceTiers: vi.fn(
                async (
                    _models: readonly string[],
                    _options?: { signal?: AbortSignal },
                ): Promise<Readonly<Record<string, readonly string[]>>> => tiers,
            ),
        },
    );
}
