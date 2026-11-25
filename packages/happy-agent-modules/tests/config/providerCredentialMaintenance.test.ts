import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CodexApiKeyCredential,
    CodexProvider,
    CodexSessionCredential,
    GrokProvider,
    GrokSessionCredential,
} from "@slopus/happy-providers";
import { createRootContext, withLogger, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];
const configs: ConfigModule[] = [];
const ctx = createRootContext().named("credential-maintenance-test");
const THREE_HOURS = 3 * 60 * 60 * 1_000;

afterEach(async () => {
    for (const config of configs.splice(0)) config.closeProviders();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("configuration-owned credential maintenance", () => {
    it("uses the published providers to rotate isolated login files after startup while idle", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-idle-credentials-"));
        roots.push(root);
        const codexFile = join(root, "codex.json");
        const grokFile = join(root, "grok.json");
        const requests: string[] = [];
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) {
                /* Drain the real token request. */
            }
            if (request.url === "/.well-known/openid-configuration") {
                response.end(JSON.stringify({ token_endpoint: `${origin}/grok-token` }));
                return;
            }
            requests.push(request.url ?? "");
            response.end(
                JSON.stringify({
                    access_token: "fresh-access",
                    refresh_token: "fresh-refresh",
                    expires_in: 21_600,
                }),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture port.");
        const origin = `http://127.0.0.1:${address.port}`;
        let config: ConfigModule | undefined;
        try {
            await writeFile(
                codexFile,
                JSON.stringify({
                    tokens: { access_token: "old-access", refresh_token: "old-refresh" },
                }),
            );
            await writeFile(
                grokFile,
                JSON.stringify({
                    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
                        key: "old-access",
                        refresh_token: "old-refresh",
                        oidc_issuer: origin,
                        oidc_client_id: "fixture-client",
                    },
                }),
            );
            vi.stubEnv("CODEX_REFRESH_TOKEN_URL_OVERRIDE", `${origin}/codex-token`);
            config = await fixture(
                [
                    ["codex", codexFile],
                    ["grok", grokFile],
                ]
                    .flatMap(([type, file]) => [
                        `[providers.${type}_idle]`,
                        `type = "${type}"`,
                        "enabled = true",
                        "hidden = true",
                        "credential_isolation = true",
                        `auth_file = ${JSON.stringify(file)}`,
                    ])
                    .join("\n"),
            );
            await config.beforeStart().afterStart?.(ctx, {} as never);
            await expect.poll(() => readFile(codexFile, "utf8")).toContain("fresh-refresh");
            await expect.poll(() => readFile(grokFile, "utf8")).toContain("fresh-refresh");
            expect(requests.sort()).toEqual(["/codex-token", "/grok-token"]);
        } finally {
            config?.closeProviders();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("starts once after startup and repeats every three hours without inference", async () => {
        const config = await fixture();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const refresh = vi.spyOn(config, "refreshProviderCredentials").mockResolvedValue();
        const hooks = config.beforeStart();
        await hooks.afterStart?.(ctx, {} as never);
        await hooks.afterStart?.(ctx, {} as never);
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(THREE_HOURS - 1);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(2);
        config.closeProviders();
        await vi.advanceTimersByTimeAsync(THREE_HOURS * 2);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps slow passes off startup and does not overlap them", async () => {
        const config = await fixture();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const refresh = vi
            .spyOn(config, "refreshProviderCredentials")
            .mockReturnValueOnce(pending)
            .mockResolvedValue();
        await config.beforeStart().afterStart?.(ctx, {} as never);
        await vi.advanceTimersByTimeAsync(THREE_HOURS * 2);
        expect(refresh).toHaveBeenCalledTimes(1);
        finish();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(THREE_HOURS);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("includes enabled hidden accounts, skips Claude, aliases, disabled accounts and keys, and never opens a session", async () => {
        const config = await fixture(
            [
                "[providers.hidden_codex]",
                'type = "codex"',
                "enabled = true",
                "hidden = true",
                "[providers.grok]",
                "enabled = true",
                "[providers.claude]",
                "enabled = true",
                "[providers.key]",
                'type = "codex"',
                "enabled = true",
                'api_key = "static-test-key"',
                "[providers.smart]",
                'type = "smart"',
                "enabled = true",
                'providers = ["hidden_codex"]',
            ].join("\n"),
        );
        const codex = new CodexProvider({
            credential: CodexSessionCredential.fromAuth(
                { accessToken: "fixture" },
                { authFile: "/not-used" },
            ),
        });
        const grok = await grokProvider();
        const codexRefresh = vi
            .spyOn(codex.credential as CodexSessionCredential, "refreshForMaintenance")
            .mockResolvedValue(codex.credential as CodexSessionCredential);
        const grokRefresh = vi
            .spyOn(grok.credential as GrokSessionCredential, "refreshForMaintenance")
            .mockResolvedValue(true);
        const codexSession = vi.spyOn(codex, "session");
        const grokSession = vi.spyOn(grok, "session");
        const resolve = vi
            .spyOn(config, "resolveProviderUnchecked")
            .mockImplementation(async (id) => (id === "hidden_codex" ? codex : grok));
        await config.refreshProviderCredentials(ctx);
        expect(resolve.mock.calls.map(([id]) => id).sort()).toEqual(["grok", "hidden_codex"]);
        expect(codexRefresh).toHaveBeenCalledOnce();
        expect(grokRefresh).toHaveBeenCalledOnce();
        expect(codexSession).not.toHaveBeenCalled();
        expect(grokSession).not.toHaveBeenCalled();
        config.setProviderEnabled("hidden_codex", false);
        await config.refreshProviderCredentials(ctx);
        expect(codexRefresh).toHaveBeenCalledOnce();
        expect(grokRefresh).toHaveBeenCalledTimes(2);
    });

    it("leaves account enablement intact on failure and can refresh on the next pass", async () => {
        const config = await fixture("[providers.codex]\nenabled = true");
        const credential = CodexSessionCredential.fromAuth(
            { accessToken: "fixture" },
            { authFile: "/not-used" },
        );
        const provider = new CodexProvider({ credential });
        vi.spyOn(config, "resolveProviderUnchecked").mockResolvedValue(provider);
        const refresh = vi
            .spyOn(credential, "refreshForMaintenance")
            .mockRejectedValueOnce(new Error("DO_NOT_LOG_THIS_SECRET"))
            .mockResolvedValue(credential);
        await expect(config.refreshProviderCredentials(ctx)).resolves.toBeUndefined();
        expect(config.isProviderEnabled("codex")).toBe(true);
        await config.refreshProviderCredentials(ctx);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("logs only the status and vetted OAuth code of a failed background refresh", async () => {
        const config = await fixture("[providers.codex]\nenabled = true");
        const credential = CodexSessionCredential.fromAuth(
            { accessToken: "fixture" },
            { authFile: "/not-used" },
        );
        vi.spyOn(config, "resolveProviderUnchecked").mockResolvedValue(
            new CodexProvider({ credential }),
        );
        // The provider library's refresh failure: a status, an OAuth code, and its classification.
        const failure = (code: string, status: number, permanent: boolean) =>
            Object.assign(new Error("DO_NOT_LOG_THIS_SECRET"), { status, code, permanent });
        vi.spyOn(credential, "refreshForMaintenance")
            .mockRejectedValueOnce(failure("refresh_token_reused", 401, true))
            .mockRejectedValueOnce(failure("server_error", 503, false))
            .mockRejectedValueOnce(failure("DO_NOT_LOG free text", 400, false))
            .mockRejectedValueOnce(new Error("DO_NOT_LOG_THIS_SECRET"));
        const [logged, warnings] = capturingContext(ctx);
        for (let pass = 0; pass < 4; pass++) await config.refreshProviderCredentials(logged);
        expect(warnings).toEqual([
            'Could not refresh the sign-in for provider "codex" in the background (HTTP 401, refresh_token_reused). Sign in to this account again.',
            'Could not refresh the sign-in for provider "codex" in the background (HTTP 503, server_error).',
            'Could not refresh the sign-in for provider "codex" in the background.',
            'Could not refresh the sign-in for provider "codex" in the background.',
        ]);
    });

    it("tells login listeners how each renewal ended, but not when the credential cannot load", async () => {
        const config = await fixture("[providers.codex]\nenabled = true");
        const credential = CodexSessionCredential.fromAuth(
            { accessToken: "fixture" },
            { authFile: "/not-used" },
        );
        const resolve = vi
            .spyOn(config, "resolveProviderUnchecked")
            .mockResolvedValue(new CodexProvider({ credential }));
        const failure = Object.assign(new Error("DO_NOT_REPORT_THIS_SECRET"), {
            status: 401,
            code: "refresh_token_reused",
            permanent: true,
        });
        vi.spyOn(credential, "refreshForMaintenance")
            .mockRejectedValueOnce(failure)
            .mockRejectedValueOnce(new Error("DO_NOT_REPORT_THIS_SECRET"))
            .mockResolvedValueOnce(credential);
        const changes: unknown[] = [];
        config.onProviderLoginChanged((providerId, change) => changes.push({ providerId, change }));
        for (let pass = 0; pass < 3; pass++) await config.refreshProviderCredentials(ctx);
        resolve.mockRejectedValueOnce(new Error("The Codex sign-in is missing."));
        await config.refreshProviderCredentials(ctx);

        expect(changes).toEqual([
            {
                providerId: "codex",
                change: {
                    kind: "refresh_failed",
                    status: 401,
                    code: "refresh_token_reused",
                    permanent: true,
                },
            },
            {
                providerId: "codex",
                change: { kind: "refresh_failed", status: null, code: null, permanent: false },
            },
            { providerId: "codex", change: { kind: "refreshed" } },
        ]);
        expect(JSON.stringify(changes)).not.toContain("DO_NOT_REPORT");
    });

    it("reports a Grok renewal that returned no credential as a failure without a status", async () => {
        const config = await fixture("[providers.grok]\nenabled = true");
        const provider = await grokProvider();
        vi.spyOn(config, "resolveProviderUnchecked").mockResolvedValue(provider);
        vi.spyOn(provider.credential as GrokSessionCredential, "refreshForMaintenance")
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const changes: unknown[] = [];
        config.onProviderLoginChanged((providerId, change) => changes.push({ providerId, change }));
        await config.refreshProviderCredentials(ctx);
        await config.refreshProviderCredentials(ctx);

        expect(changes).toEqual([
            {
                providerId: "grok",
                change: { kind: "refresh_failed", status: null, code: null, permanent: false },
            },
            { providerId: "grok", change: { kind: "refreshed" } },
        ]);
    });

    it("does not mistake an environment API key for a refreshable session", async () => {
        const config = await fixture("[providers.codex]\nenabled = true");
        const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "fixture" });
        if (credential === null) throw new Error("Missing fixture key.");
        const provider = new CodexProvider({ credential });
        vi.spyOn(config, "resolveProviderUnchecked").mockResolvedValue(provider);
        const session = vi.spyOn(provider, "session");
        await config.refreshProviderCredentials(ctx);
        expect(session).not.toHaveBeenCalled();
    });

    it("shutdown cancels a maintenance observer and stops resolving accounts", async () => {
        const config = await fixture("[providers.codex]\nenabled = true");
        const credential = CodexSessionCredential.fromAuth(
            { accessToken: "fixture" },
            { authFile: "/not-used" },
        );
        const provider = new CodexProvider({ credential });
        const resolve = vi.spyOn(config, "resolveProviderUnchecked").mockResolvedValue(provider);
        let started!: () => void;
        const ready = new Promise<void>((done) => {
            started = done;
        });
        vi.spyOn(credential, "refreshForMaintenance").mockImplementation(
            async ({ signal } = {}) => {
                started();
                await new Promise<void>((_resolve, reject) =>
                    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
                );
                return credential;
            },
        );
        const pass = config.refreshProviderCredentials(ctx);
        await ready;
        config.closeProviders();
        await expect(pass).resolves.toBeUndefined();
        await config.refreshProviderCredentials(ctx);
        expect(resolve).toHaveBeenCalledOnce();
    });
});

function capturingContext(context: Context): [Context, string[]] {
    const warnings: string[] = [];
    const logged = withLogger(context, {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (_logContext, ...args) => {
            warnings.push(args.map(String).join(" "));
        },
        error: () => {},
        fatal: () => {},
    });
    return [logged, warnings];
}

async function fixture(extra = "") {
    const root = await mkdtemp(join(tmpdir(), "happy-credential-maintenance-module-"));
    roots.push(root);
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "happy.toml"), `[providers]\ndefault_enable = false\n${extra}`);
    const config = await ConfigModule.load(join(root, ".happy"));
    configs.push(config);
    return config;
}

async function grokProvider() {
    const root = await mkdtemp(join(tmpdir(), "happy-grok-maintenance-module-"));
    roots.push(root);
    const authFile = join(root, "auth.json");
    await writeFile(
        authFile,
        JSON.stringify({
            "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": { key: "fixture" },
        }),
    );
    const credential = await GrokSessionCredential.tryLoad({ authFile, env: {} });
    if (credential === null) throw new Error("Missing fixture credential.");
    return new GrokProvider({ credential });
}
