import { createRootContext } from "@steve.kite/stdlib";
import type { BaseSession } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import { createScriptedInference, GYM_MODEL_ID, GYM_PROVIDER_ID } from "../sources/index.js";

const ctx = createRootContext().named("scripted-inference-test");

describe("scripted inference", () => {
    it("keeps detached naming requests out of fixed agent-turn scripts", async () => {
        const scripted = createScriptedInference({
            inference: [{ content: [{ text: "agent answer", type: "text" }] }],
        });
        const provider = await scripted.providers.resolve(GYM_PROVIDER_ID, GYM_MODEL_ID);
        expect(provider).not.toBeNull();
        if (provider === null) return;

        const naming = await provider.session("naming:test", {
            instructions: "Name it.",
            tools: [],
        });
        const agent = await provider.session("agent-test", { instructions: "Answer.", tools: [] });

        expect(await runText(naming, "Suggest a title.")).toContain("<title>Gym session</title>");
        expect(await runText(agent, "Answer the user.")).toBe("agent answer");
        expect(
            scripted.log.requests.map(({ callIndex, sessionId }) => ({ callIndex, sessionId })),
        ).toEqual([{ callIndex: 0, sessionId: "agent-test" }]);
        expect(scripted.log.unscripted).toEqual([]);

        await naming.destroy();
        await agent.destroy();
    });
});

async function runText(session: BaseSession, prompt: string): Promise<string> {
    let text = "";
    for await (const event of session.run(ctx, {
        context: {
            instructions: "",
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        },
        model: GYM_MODEL_ID,
    })) {
        if (event.type === "text_delta") text += event.delta;
    }
    return text;
}
