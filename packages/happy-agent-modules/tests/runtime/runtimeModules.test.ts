import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import { CodexApiKeyCredential, CodexProvider } from "@slopus/happy-providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";

/** One configured account and one model, so the runtime has something to boot against. */
async function inference(): Promise<{ models: AgentModel[]; providers: AgentProviders }> {
    const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "test-key" });
    const providers = new AgentProviders();
    providers.add(
        "gym",
        new CodexProvider({
            credential: credential!,
            endpoint: "https://example.invalid/v1",
            userAgent: "happy-runtime-test/1.0",
        }),
        "codex",
    );
    return {
        models: [
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym/model",
                name: "Gym Model",
                providerId: "gym",
            },
        ],
        providers,
    };
}

let happyHome: string;
let runtime: HappyAgentRuntime | undefined;

beforeEach(async () => {
    happyHome = await mkdtemp(join(tmpdir(), "happy-runtime-modules-"));
});

afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await rm(happyHome, { force: true, recursive: true });
});

describe("the runtime's modules", () => {
    /**
     * A module that is composed here but never installed never boots, so its whole feature is
     * silently absent from the product. Gemini was exactly that: the module existed and offered
     * its tools, but nothing installed it, so no agent ever saw one of them.
     */
    it("installs every module it composes, so each one actually boots", async () => {
        runtime = await startHappyAgentRuntime({
            happyHome,
            inference: await inference(),
        });
        const agent = await runtime.system.create(runtime.ctx, {});

        // A composed value with a `beforeStart` is an agent module with runtime behavior, so an
        // agent must be able to reach it. Plain API-facing services, such as terminals, are not.
        const composed = Object.values(runtime.modules)
            .filter(
                (module) => typeof (module as { beforeStart?: unknown }).beforeStart === "function",
            )
            .map((module) => (module as { name: string }).name);
        const missing = composed.filter((name) => agent.module(name) === undefined);

        expect(composed).toContain("gemini");
        expect(missing).toEqual([]);
    });
});
