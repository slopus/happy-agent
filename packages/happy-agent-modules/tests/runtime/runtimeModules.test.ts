import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import { CodexApiKeyCredential, CodexProvider } from "@slopus/happy-providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MONTY_CODE_MODE_INSTRUCTIONS } from "../../sources/codeMode/engines/monty/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

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
        expect(composed).toContain("code-mode");
        expect(missing).toEqual([]);
    });

    it("boots enabled Code Mode as the complete prompt and one-tool surface", async () => {
        const bootstrapConfig = await ConfigModule.load(happyHome);
        const paths = bootstrapConfig.configuration.paths;
        const workspace = join(happyHome, "workspace");
        bootstrapConfig.closeProviders();
        await Promise.all([
            mkdir(dirname(paths.globalConfigPath), { recursive: true }),
            mkdir(workspace, { recursive: true }),
        ]);
        await writeFile(paths.globalConfigPath, "[feature.codemode]\nenabled = true\n");
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "done" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const providers = new AgentProviders();
        providers.add("gym", provider, "codex");
        runtime = await startHappyAgentRuntime({
            happyHome,
            inference: {
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
            },
        });
        const agent = await runtime.system.create(runtime.ctx, {
            modules: { compute: { cwd: workspace } },
        });

        await agent.send(runtime.ctx, {
            role: "user",
            content: [{ type: "text", text: "calculate" }],
        });
        await agent.waitForIdle();

        const codeModeSession = provider.sessions.find(
            (session) => session.options.instructions === MONTY_CODE_MODE_INSTRUCTIONS,
        );
        expect(codeModeSession?.options.instructions).toBe(MONTY_CODE_MODE_INSTRUCTIONS);
        expect(codeModeSession?.options.tools?.map((tool) => tool.name)).toEqual(["python"]);
    });
});
