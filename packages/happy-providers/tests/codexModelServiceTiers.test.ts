import { afterEach, expect, it, vi } from "vitest";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";

const credential = (accountId = "account-a", accessToken = "token-a") =>
    CodexSessionCredential.fromAuth(
        { accountId, accessToken },
        { authFile: `/isolated/${accountId}/auth.json` },
    );
const provider = (accountId = "account-a") =>
    new CodexProvider({
        credential: credential(accountId),
        userAgent: "codex_exec/0.154.0 (test)",
    });

afterEach(() => vi.restoreAllMocks());

it("reads only requested model tier capabilities using each configured account", async () => {
    vi.spyOn(CodexSessionCredential, "tryLoad").mockImplementation(async (options) =>
        credential(options?.authFile?.includes("account-b") ? "account-b" : "account-a"),
    );
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
        const account = new Headers(options?.headers).get("chatgpt-account-id");
        return Response.json({
            models: [
                {
                    slug: "gpt-6-astra",
                    service_tiers: [
                        { id: "priority" },
                        ...(account === "account-a" ? [{ id: "ultrafast" }] : []),
                    ],
                },
                { slug: "gpt-6-sol", service_tiers: [{ id: "priority" }] },
                { slug: "not-curated", service_tiers: [{ id: "ultrafast" }] },
            ],
        });
    });
    expect(await provider().modelServiceTiers(["openai/gpt-6-astra", "openai/gpt-6-sol"])).toEqual({
        "openai/gpt-6-astra": ["priority", "ultrafast"],
        "openai/gpt-6-sol": ["priority"],
    });
    expect(await provider("account-b").modelServiceTiers(["openai/gpt-6-astra"])).toEqual({
        "openai/gpt-6-astra": ["priority"],
    });
    expect(fetcher.mock.calls[0]?.[0]?.toString()).toBe(
        "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});

it("invalidates the opaque account key after token changes and fails closed on account switches", async () => {
    const loader = vi.spyOn(CodexSessionCredential, "tryLoad").mockResolvedValue(credential());
    const source = provider();
    const first = await source.serviceTierAccountKey();
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    loader.mockResolvedValue(credential("account-a", "rotated"));
    expect(await source.serviceTierAccountKey()).not.toBe(first);
    loader.mockResolvedValue(credential("account-b"));
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect(await source.serviceTierAccountKey()).toBeNull();
    expect(await source.modelServiceTiers(["openai/gpt-6-astra"])).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
});

it.each(["failure", "invalid", "oversize", "absent"])(
    "fails closed for %s catalog data",
    async (kind) => {
        vi.spyOn(CodexSessionCredential, "tryLoad").mockResolvedValue(credential());
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            if (kind === "failure") throw new Error("sensitive vendor diagnostic");
            if (kind === "invalid")
                return Response.json({
                    models: [{ slug: "gpt-6-astra", service_tiers: "ultrafast" }],
                });
            if (kind === "oversize") return new Response(" ".repeat(2_097_153));
            return Response.json({ models: [{ slug: "gpt-6-astra" }] });
        });
        expect(await provider().modelServiceTiers(["openai/gpt-6-astra"])).toEqual({});
    },
);

it("does not probe API-key providers or an already cancelled check", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const keyed = new CodexProvider({
        credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
    });
    expect(await keyed.serviceTierAccountKey()).toBeNull();
    expect(await keyed.modelServiceTiers(["openai/gpt-6-astra"])).toEqual({});
    expect(
        await provider().modelServiceTiers(["openai/gpt-6-astra"], { signal: AbortSignal.abort() }),
    ).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
});

it("discards capabilities if the stored account changes while the response is in flight", async () => {
    const loader = vi.spyOn(CodexSessionCredential, "tryLoad").mockResolvedValue(credential());
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        loader.mockResolvedValue(credential("account-b"));
        return Response.json({
            models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "ultrafast" }] }],
        });
    });
    expect(await provider().modelServiceTiers(["openai/gpt-6-astra"])).toEqual({});
});

it("ignores unrecognized tiers and models missing from the account catalog", async () => {
    vi.spyOn(CodexSessionCredential, "tryLoad").mockResolvedValue(credential());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
            models: [
                {
                    slug: "gpt-6-astra",
                    service_tiers: [{ id: "priority" }, { id: "priority" }, { id: "future-tier" }],
                },
            ],
        }),
    );
    expect(await provider().modelServiceTiers(["openai/gpt-6-astra", "openai/gpt-6-sol"])).toEqual({
        "openai/gpt-6-astra": ["priority"],
    });
});
