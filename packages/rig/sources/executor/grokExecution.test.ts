import { describe, expect, it } from "vitest";

import { GrokProvider } from "@slopus/rig-providers";

import { grokExecution } from "./grokExecution.js";

const env = { XAI_API_KEY: "test-api-key" } satisfies NodeJS.ProcessEnv;

async function grokProvider(
    hostedCapabilitiesForRequest?: Parameters<
        typeof grokExecution
    >[0]["hostedCapabilitiesForRequest"],
): Promise<GrokProvider> {
    const { native } = grokExecution({
        config: { enabled: true, type: "grok" },
        env,
        ...(hostedCapabilitiesForRequest === undefined ? {} : { hostedCapabilitiesForRequest }),
        id: "grok",
    });
    if (typeof native !== "function") throw new Error("Grok resolves its provider lazily.");
    const provider = await native({} as never);
    expect(provider).toBeInstanceOf(GrokProvider);
    return provider as GrokProvider;
}

async function hostedToolNames(
    hostedCapabilitiesForRequest?: Parameters<
        typeof grokExecution
    >[0]["hostedCapabilitiesForRequest"],
): Promise<readonly string[] | undefined> {
    return (await grokProvider(hostedCapabilitiesForRequest)).hostedTools?.().map((t) => t.name);
}

describe("grokExecution", () => {
    it("declares no hosted search when nothing granted it any", async () => {
        expect(await hostedToolNames()).toEqual([]);
        expect(await hostedToolNames(() => [])).toEqual([]);
    });

    it("declares only the hosted searches it was granted", async () => {
        expect(await hostedToolNames(() => ["x_search"])).toEqual(["x_search"]);
        expect(await hostedToolNames(() => ["web_search", "x_search"])).toEqual([
            "web_search",
            "x_search",
        ]);
    });

    // The provider is built once and used for the rest of the session, so this has to be asked
    // again rather than captured. Otherwise leaving Auto would keep searching until the next
    // session, and coming back to Auto would never search again.
    it("asks again for every request rather than keeping the first answer", async () => {
        let allowed: readonly ("web_search" | "x_search")[] = ["web_search", "x_search"];
        const provider = await grokProvider(() => allowed);

        expect(provider.hostedTools?.().map((t) => t.name)).toEqual(["web_search", "x_search"]);
        allowed = [];
        expect(provider.hostedTools?.()).toEqual([]);
        allowed = ["x_search"];
        expect(provider.hostedTools?.().map((t) => t.name)).toEqual(["x_search"]);
    });
});
