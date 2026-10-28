import { describe, expect, it } from "vitest";

import type { ProviderCli } from "../../sources/providerClis/index.js";
import { assembleProviderRoutes } from "../../sources/providerRoutes/impl/assembleProviderRoutes.js";
import type {
    ConfiguredProviders,
    DetectedRoute,
} from "../../sources/providerRoutes/impl/DetectedRoute.js";
import { detectDirectRoutes } from "../../sources/providerRoutes/impl/detectDirectRoutes.js";

function detected(overrides: Partial<DetectedRoute> & Pick<DetectedRoute, "id">): DetectedRoute {
    return {
        kind: "direct",
        name: overrides.id,
        vendors: [],
        billing: "subscription",
        account: null,
        endpoint: null,
        status: "ready",
        models: null,
        warning: null,
        ...overrides,
    };
}

function providers(
    configured: Record<string, { enabled: boolean; type: string; baseUrl?: string }>,
): ConfiguredProviders {
    return {
        has: (id) => configured[id] !== undefined,
        isEnabled: (id) => configured[id]?.enabled === true,
        typeOf: (id) => configured[id]?.type ?? null,
        at: (baseUrl) =>
            Object.entries(configured).find(([, provider]) => provider.baseUrl === baseUrl)?.[0],
    };
}

const PROXY = detected({
    id: "cliproxyapi",
    kind: "local_proxy",
    name: "CLIProxyAPI",
    vendors: ["Anthropic", "OpenAI"],
    endpoint: "http://127.0.0.1:8317/v1",
    provider: {
        id: "cliproxyapi",
        table: { type: "openai_compatible", base_url: "http://127.0.0.1:8317/v1", api_key: "k" },
        summary: "Adds CLIProxyAPI on this computer with 2 models.",
    },
});

describe("assembling provider routes", () => {
    it("orders by kind, marks overlaps, and starts a proxy unchecked beside a ready sign-in", () => {
        const routes = assembleProviderRoutes(
            [
                PROXY,
                detected({ id: "ollama", kind: "local_models", name: "Ollama", billing: "local" }),
                detected({
                    id: "claude",
                    name: "Claude Code",
                    vendors: ["Anthropic"],
                    providerId: "claude",
                }),
                detected({ id: "codex", name: "Codex", vendors: ["OpenAI"], providerId: "codex" }),
            ],
            providers({
                claude: { enabled: true, type: "claude" },
                codex: { enabled: true, type: "codex" },
            }),
        );

        expect(routes.map((route) => [route.id, route.overlaps, route.recommended])).toEqual([
            ["claude", ["cliproxyapi"], true],
            ["codex", ["cliproxyapi"], true],
            ["cliproxyapi", ["claude", "codex"], false],
            ["ollama", [], false],
        ]);
        // The enabled built-in needs nothing; the proxy would be added for the next start.
        expect(routes[0]).toMatchObject({ providerId: "claude", use: null });
        expect(routes[2]).toMatchObject({
            providerId: null,
            use: {
                providerId: "cliproxyapi",
                type: "openai_compatible",
                summary: "Adds CLIProxyAPI on this computer with 2 models.",
                restartRequired: true,
            },
        });
        // What only the daemon may see, such as the proxy's key, never reaches the route.
        expect(JSON.stringify(routes)).not.toContain('"k"');
        expect(routes[2]).not.toHaveProperty("provider");
    });

    it("reaches each vendor one way by default: the first route that brings it", () => {
        const key = detected({ id: "env:OPENAI_API_KEY", kind: "api_key", vendors: ["OpenAI"] });
        const routes = assembleProviderRoutes(
            [
                PROXY,
                key,
                detected({ id: "aws_profile:a", kind: "cloud", vendors: ["Amazon Bedrock"] }),
                detected({ id: "aws_profile:b", kind: "cloud", vendors: ["Amazon Bedrock"] }),
            ],
            providers({}),
        );
        expect(routes.map((route) => [route.id, route.recommended])).toEqual([
            ["env:OPENAI_API_KEY", true],
            // The key already brings OpenAI, but nothing else brings Anthropic.
            ["cliproxyapi", true],
            ["aws_profile:a", true],
            ["aws_profile:b", false],
        ]);
    });

    it("recommends a proxy that is the only way to a vendor, or whose sign-in is signed out", () => {
        const routes = assembleProviderRoutes(
            [
                PROXY,
                detected({
                    id: "claude",
                    vendors: ["Anthropic"],
                    status: "needs_sign_in",
                    providerId: "claude",
                }),
            ],
            providers({ claude: { enabled: false, type: "claude" } }),
        );
        expect(routes.find((route) => route.id === "cliproxyapi")?.recommended).toBe(true);
        // A built-in that is off but signed out cannot be turned on usefully yet.
        expect(routes.find((route) => route.id === "claude")).toMatchObject({
            recommended: false,
            use: null,
        });
    });

    it("lets a route detection cannot vouch for be chosen, without starting it checked", () => {
        const routes = assembleProviderRoutes(
            [
                detected({
                    id: "claude_home:.claude-work",
                    vendors: ["Anthropic"],
                    status: "unknown",
                    provider: {
                        id: "claude_work",
                        table: { type: "claude", config_dir: "/home/ada/.claude-work" },
                        summary: "Adds Claude Code with the account in ~/.claude-work.",
                    },
                }),
            ],
            providers({}),
        );
        expect(routes[0]).toMatchObject({
            recommended: false,
            use: { providerId: "claude_work", type: "claude", restartRequired: true },
        });
    });

    it("turns on a ready built-in that is off, and finds a provider already at the same address", () => {
        const routes = assembleProviderRoutes(
            [
                PROXY,
                detected({ id: "codex", name: "Codex", vendors: ["OpenAI"], providerId: "codex" }),
            ],
            providers({
                codex: { enabled: false, type: "codex" },
                cliproxy: {
                    enabled: true,
                    type: "openai_compatible",
                    baseUrl: "http://127.0.0.1:8317/v1",
                },
            }),
        );
        expect(routes.find((route) => route.id === "codex")?.use).toEqual({
            providerId: "codex",
            type: "codex",
            summary: "Turns on Codex.",
            restartRequired: false,
        });
        expect(routes.find((route) => route.id === "cliproxyapi")).toMatchObject({
            providerId: "cliproxy",
            use: null,
        });
    });
});

function cli(overrides: Partial<ProviderCli> & Pick<ProviderCli, "id" | "name">): ProviderCli {
    return {
        vendor: "Vendor",
        website: "https://example.com",
        providerId: overrides.id,
        installation: {
            status: "installed",
            path: "/bin/x",
            version: "1.0.0",
            source: "standalone",
            desktopApp: null,
        },
        installer: null,
        commands: { run: "x", signIn: "x login" },
        signIn: { status: "signed_in", account: null, methods: ["browser"] },
        operation: null,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        updatedAt: 0,
        ...overrides,
    };
}

describe("routes from provider CLIs", () => {
    it("reports each vendor sign-in, its account and models, and skips what is absent", () => {
        const routes = detectDirectRoutes(
            [
                cli({
                    id: "claude",
                    name: "Claude Code",
                    signIn: {
                        status: "signed_in",
                        account: { email: "ada@example.com", plan: "Max" },
                        methods: ["browser"],
                    },
                }),
                cli({
                    id: "codex",
                    name: "Codex",
                    installation: {
                        status: "installed",
                        path: "/Applications/ChatGPT.app/codex",
                        version: "1.0.0",
                        source: "desktop_app",
                        desktopApp: "ChatGPT",
                    },
                    signIn: { status: "signed_out", account: null, methods: ["browser"] },
                }),
                cli({
                    id: "grok",
                    name: "Grok",
                    installation: {
                        status: "missing",
                        path: null,
                        version: null,
                        source: null,
                        desktopApp: null,
                    },
                    signIn: { status: "unknown", account: null, methods: [] },
                }),
                cli({ id: "antigravity", name: "Antigravity" }),
            ],
            (providerId, vendor) => [{ id: `${providerId}-model`, vendor }],
        );

        expect(routes).toEqual([
            {
                id: "claude",
                kind: "direct",
                name: "Claude Code",
                vendors: ["Anthropic"],
                billing: "subscription",
                account: {
                    label: "ada@example.com",
                    email: "ada@example.com",
                    plan: "Max",
                    count: null,
                },
                endpoint: null,
                status: "ready",
                models: [{ id: "claude-model", vendor: "Anthropic" }],
                warning: null,
                providerId: "claude",
            },
            expect.objectContaining({
                id: "codex",
                kind: "desktop_app",
                name: "Codex in the ChatGPT app",
                status: "needs_sign_in",
            }),
        ]);
    });
});
