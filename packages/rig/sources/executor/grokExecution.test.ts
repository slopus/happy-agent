import { describe, expect, it } from "vitest";

import { GrokProvider } from "@slopus/rig-providers";

import { grokExecution } from "./grokExecution.js";

const env = { XAI_API_KEY: "test-api-key" } satisfies NodeJS.ProcessEnv;

async function hostedToolNames(
    hostedCapabilities?: Parameters<typeof grokExecution>[0]["hostedCapabilities"],
): Promise<readonly string[] | undefined> {
    const { native } = grokExecution({
        config: { enabled: true, type: "grok" },
        env,
        ...(hostedCapabilities === undefined ? {} : { hostedCapabilities }),
        id: "grok",
    });
    if (typeof native !== "function") throw new Error("Grok resolves its provider lazily.");
    const provider = await native({} as never);
    expect(provider).toBeInstanceOf(GrokProvider);
    return (provider as GrokProvider).hostedTools?.map((tool) => tool.name);
}

describe("grokExecution", () => {
    it("declares no hosted search when nothing granted it any", async () => {
        expect(await hostedToolNames()).toBeUndefined();
        expect(await hostedToolNames([])).toBeUndefined();
    });

    it("declares only the hosted searches it was granted", async () => {
        expect(await hostedToolNames(["x_search"])).toEqual(["x_search"]);
        expect(await hostedToolNames(["web_search", "x_search"])).toEqual([
            "web_search",
            "x_search",
        ]);
    });
});
