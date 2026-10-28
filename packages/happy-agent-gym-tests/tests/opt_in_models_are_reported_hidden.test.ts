import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const SOL = "openai/gpt-6-sol";

const gyms: AgentGym[] = [];
afterEach(async () => {
    for (const gym of gyms.splice(0)) await gym.dispose();
});

async function models(includeModels?: readonly string[]) {
    const gym = await createAgentGym({
        config: [
            "[providers]",
            "default_enable = false",
            "[providers.codex]",
            "enabled = true",
            ...(includeModels === undefined
                ? []
                : [`include_models = ${JSON.stringify(includeModels)}`]),
        ].join("\n"),
    });
    gyms.push(gym);
    const { providers } = (await gym.client.getConfig()).config;
    return { codex: providers.codex!.models, bedrock: providers.bedrock!.models };
}

describe("opt-in models", () => {
    it("reports GPT-6 Sol hidden but enabled on Codex, and its successor offered", async () => {
        const { codex: references, bedrock } = await models();
        expect(references.find((model) => model.id === SOL)).toMatchObject({
            enabled: true,
            hidden: true,
        });
        expect(references.find((model) => model.id === "openai/gpt-6.1-sol")).toMatchObject({
            enabled: true,
            hidden: false,
        });
        expect(references.filter((model) => model.hidden).map((model) => model.id)).toEqual([SOL]);
    }, 60_000);

    it("offers GPT-6 Sol again when the account's include_models names it", async () => {
        const { codex: references } = await models(["openai/gpt-6.1-sol", SOL]);
        expect(references.find((model) => model.id === SOL)).toMatchObject({
            enabled: true,
            hidden: false,
        });
    }, 60_000);
});
